#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	V34_B1_PREFLIGHT_FLAG_KEYS,
	canonicalSha256,
	deriveStoragePrefix,
	parseCli,
	runAuthorizedStoragePreflight,
	validateAuthorizationBasis,
	validateStoragePreflightReport
} from './run-v34-b1-storage-preflight.mjs';

const roots = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const SCRIPT = fileURLToPath(new URL('./run-v34-b1-storage-preflight.mjs', import.meta.url));

function temporaryRoot() {
	const root = mkdtempSync(path.join(os.tmpdir(), 'v34-b1-storage-preflight-'));
	roots.push(root);
	return root;
}

function flags() {
	return Object.fromEntries(
		V34_B1_PREFLIGHT_FLAG_KEYS.map((key) => [key, key === 'storagePreflightOpen'])
	);
}

function createFixture(overrides = {}) {
	const root = temporaryRoot();
	const outputPath = path.join(root, 'evidence', 'b1-storage-preflight.json');
	const attemptRoot = path.join(root, 'scratch-attempt');
	mkdirSync(path.dirname(outputPath), { recursive: true });
	const authorizationBasis = {
		sourceImplementation: 'ff2aa7cc4e69f0f7da530a0d0df418c26839314e',
		storage: {
			kind: 's3',
			bucket: 'dev-simforge-435362779479-models',
			region: 'us-west-1',
			profile: 'simforge',
			prefixTemplate: 'arc-spirits/v34/lane-b/<authorization-basis-sha256>/'
		},
		storagePreflight: {
			awsExecutable: '/synthetic/bin/aws',
			attemptRoot,
			outputPath,
			probeBytes: 4096,
			projectedSmokePeakBytes: 16_384,
			scratchMultiplier: 2,
			postDeleteHeadAttempts: 2,
			postDeleteDelayMs: 0,
			metadataKey: 'sha256',
			probeKeySegment: '_unregistered-preflight'
		},
		...(overrides.authorizationBasis ?? {})
	};
	const authorizationBasisSha256 = canonicalSha256(authorizationBasis);
	const basis = {
		schemaVersion: 'arc-v34-b1-smoke-authorization-basis-v1',
		authorizationBasis,
		authorizationBasisSha256,
		derivedStoragePrefix: deriveStoragePrefix(authorizationBasisSha256),
		flags: flags(),
		...overrides.root
	};
	const basisPath = path.join(root, 'b1-smoke-authorization-basis.json');
	writeFileSync(basisPath, `${JSON.stringify(basis, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
	chmodSync(basisPath, 0o444);
	return { root, basis, basisPath, outputPath, attemptRoot };
}

function argument(args, name) {
	const index = args.indexOf(name);
	assert(index >= 0 && args[index + 1] !== undefined, `missing ${name}`);
	return args[index + 1];
}

function syntheticAws({
	corruptDownload = false,
	corruptMetadata = false,
	postDeleteAccessDenied = false,
	failPutAfterStore = false,
	putPreconditionFailed = false,
	failFirstDeleteAfterDelete = false
} = {}) {
	const objects = new Map();
	const calls = [];
	let postDelete = false;
	let deleteAttempts = 0;
	const execute = async (executable, args) => {
		calls.push({ executable, args: [...args] });
		assert.equal(executable, '/synthetic/bin/aws');
		assert.deepEqual(args.slice(0, 6), [
			'--no-cli-pager',
			'--profile',
			'simforge',
			'--region',
			'us-west-1',
			's3api'
		]);
		const operation = args[6];
		const key = argument(args, '--key');
		const bucket = argument(args, '--bucket');
		assert.equal(bucket, 'dev-simforge-435362779479-models');
		const durationMs = operation === 'put-object' ? 25 : operation === 'get-object' ? 10 : 2;
		if (operation === 'put-object') {
			assert.equal(argument(args, '--if-none-match'), '*');
			const bodyPath = argument(args, '--body');
			const metadata = argument(args, '--metadata').split('=', 2);
			if (putPreconditionFailed) {
				objects.set(key, {
					body: Buffer.from('preexisting-object'),
					metadata: { sha256: 'preexisting' }
				});
				return {
					exitCode: 254,
					stdout: Buffer.alloc(0),
					stderr: Buffer.from(
						'An error occurred (PreconditionFailed) when calling the PutObject operation: At least one precondition failed SECRET'
					),
					durationMs
				};
			}
			objects.set(key, {
				body: Buffer.from(readFileSync(bodyPath)),
				metadata: { [metadata[0]]: corruptMetadata ? '0'.repeat(64) : metadata[1] }
			});
			if (failPutAfterStore) {
				return {
					exitCode: 1,
					stdout: Buffer.alloc(0),
					stderr: Buffer.from('SECRET transport failure'),
					durationMs
				};
			}
			return {
				exitCode: 0,
				stdout: Buffer.from('{"ETag":"synthetic"}'),
				stderr: Buffer.alloc(0),
				durationMs
			};
		}
		if (operation === 'head-object') {
			const object = objects.get(key);
			if (object) {
				return {
					exitCode: 0,
					stdout: Buffer.from(
						JSON.stringify({ ContentLength: object.body.length, Metadata: object.metadata })
					),
					stderr: Buffer.alloc(0),
					durationMs
				};
			}
			if (postDeleteAccessDenied && postDelete) {
				return {
					exitCode: 254,
					stdout: Buffer.alloc(0),
					stderr: Buffer.from(
						'An error occurred (AccessDenied) when calling the HeadObject operation: request 404 is denied SECRET'
					),
					durationMs
				};
			}
			return {
				exitCode: 254,
				stdout: Buffer.alloc(0),
				stderr: Buffer.from(
					'An error occurred (404) when calling the HeadObject operation: Not Found SECRET'
				),
				durationMs
			};
		}
		if (operation === 'get-object') {
			const object = objects.get(key);
			assert(object, 'synthetic object is missing');
			const destination = args.at(-1);
			writeFileSync(
				destination,
				corruptDownload ? Buffer.concat([object.body, Buffer.from('x')]) : object.body,
				{
					flag: 'wx'
				}
			);
			return {
				exitCode: 0,
				stdout: Buffer.from('{"ChecksumSHA256":"synthetic"}'),
				stderr: Buffer.alloc(0),
				durationMs
			};
		}
		if (operation === 'delete-object') {
			deleteAttempts += 1;
			objects.delete(key);
			postDelete = true;
			if (failFirstDeleteAfterDelete && deleteAttempts === 1) {
				return {
					exitCode: 1,
					stdout: Buffer.alloc(0),
					stderr: Buffer.from('SECRET ambiguous delete transport failure'),
					durationMs
				};
			}
			return { exitCode: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0), durationMs };
		}
		throw new Error(`unexpected synthetic AWS operation ${operation}`);
	};
	return { execute, calls, objects };
}

function dependencies(aws, overrides = {}) {
	let tick = 100;
	return {
		verifyAuthorizationBasis: async ({ expectedBasis }) => expectedBasis,
		execFile: aws.execute,
		randomBytes: (bytes) => Buffer.alloc(bytes, 0xa5),
		randomUUID: () => '12345678-1234-4abc-8def-1234567890ab',
		measureFreeBytes: () => overrides.freeBytes ?? 1_000_000,
		sleep: async () => {},
		now: () => new Date('2026-07-14T23:30:00.000Z'),
		monotonic: () => (tick += 10)
	};
}

function rewriteBasis(fixture, mutate) {
	const basis = JSON.parse(readFileSync(fixture.basisPath, 'utf8'));
	mutate(basis);
	basis.authorizationBasisSha256 = canonicalSha256(basis.authorizationBasis);
	basis.derivedStoragePrefix = deriveStoragePrefix(basis.authorizationBasisSha256);
	chmodSync(fixture.basisPath, 0o644);
	writeFileSync(fixture.basisPath, `${JSON.stringify(basis, null, 2)}\n`);
	chmodSync(fixture.basisPath, 0o444);
	return basis;
}

test('canonical basis hash and derived prefix are stable', () => {
	const left = { z: 1, a: { y: 2, x: 3 } };
	const right = { a: { x: 3, y: 2 }, z: 1 };
	assert.equal(canonicalSha256(left), canonicalSha256(right));
	assert.equal(deriveStoragePrefix('a'.repeat(64)), `arc-spirits/v34/lane-b/${'a'.repeat(64)}/`);
});

test('CLI permits only explicit execute mode and exact required options', () => {
	assert.throws(() => parseCli(['--basis', 'x', '--out', 'y']), /explicit --mode execute/);
	assert.throws(
		() => parseCli(['--mode', 'dry-run', '--basis', 'x', '--out', 'y']),
		/explicit --mode execute/
	);
	assert.throws(
		() => parseCli(['--mode', 'execute', '--basis', 'x', '--out', 'y', '--aws', 'evil']),
		/Unknown option/
	);
	assert.deepEqual(
		{ ...parseCli(['--mode', 'execute', '--basis', 'x', '--out', 'y']) },
		{
			mode: 'execute',
			basis: 'x',
			out: 'y'
		}
	);
	const launched = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
	assert.equal(launched.status, 1);
	assert.match(launched.stderr, /explicit --mode execute is required/);
});

test('authorization basis must be immutable and canonical-hash bound', () => {
	const fixture = createFixture();
	assert.equal(
		validateAuthorizationBasis({
			basisPath: fixture.basisPath,
			outputPath: fixture.outputPath,
			repo: fixture.root
		}).basis.authorizationBasisSha256,
		fixture.basis.authorizationBasisSha256
	);
	chmodSync(fixture.basisPath, 0o644);
	assert.throws(
		() =>
			validateAuthorizationBasis({ basisPath: fixture.basisPath, outputPath: fixture.outputPath }),
		/read-only/
	);
	chmodSync(fixture.basisPath, 0o444);
	const tampered = JSON.parse(readFileSync(fixture.basisPath, 'utf8'));
	tampered.authorizationBasis.storage.profile = 'other';
	chmodSync(fixture.basisPath, 0o644);
	writeFileSync(fixture.basisPath, `${JSON.stringify(tampered)}\n`);
	chmodSync(fixture.basisPath, 0o444);
	assert.throws(
		() =>
			validateAuthorizationBasis({ basisPath: fixture.basisPath, outputPath: fixture.outputPath }),
		/authorizationBasisSha256/
	);
});

test('all game, registered, training, evaluation, promotion, and deployment flags stay closed', () => {
	const fixture = createFixture();
	const tampered = JSON.parse(readFileSync(fixture.basisPath, 'utf8'));
	tampered.flags.registeredCollectionOpen = true;
	chmodSync(fixture.basisPath, 0o644);
	writeFileSync(fixture.basisPath, `${JSON.stringify(tampered)}\n`);
	chmodSync(fixture.basisPath, 0o444);
	assert.throws(
		() =>
			validateAuthorizationBasis({ basisPath: fixture.basisPath, outputPath: fixture.outputPath }),
		/registeredCollectionOpen must remain false/
	);
});

test('authorization basis rejects secret-bearing fields instead of copying them into evidence', () => {
	const fixture = createFixture({
		authorizationBasis: { secretAccessKey: 'must-not-be-recorded' }
	});
	assert.throws(
		() =>
			validateAuthorizationBasis({ basisPath: fixture.basisPath, outputPath: fixture.outputPath }),
		/forbidden secret-bearing field/
	);
});

test('self-hashed minimal basis is not sufficient execution authority', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	const deps = dependencies(aws);
	delete deps.verifyAuthorizationBasis;
	await assert.rejects(
		() =>
			runAuthorizedStoragePreflight({
				basisPath: fixture.basisPath,
				outputPath: fixture.outputPath,
				repo: fixture.root,
				mode: 'execute',
				dependencies: deps
			}),
		/basis/
	);
	assert.equal(aws.calls.length, 0);
	assert.throws(() => lstatSync(fixture.outputPath), { code: 'ENOENT' });
	assert.throws(() => lstatSync(fixture.attemptRoot), { code: 'ENOENT' });
	const cli = spawnSync(
		process.execPath,
		[SCRIPT, '--mode', 'execute', '--basis', fixture.basisPath, '--out', fixture.outputPath],
		{ encoding: 'utf8', timeout: 10_000 }
	);
	assert.equal(cli.status, 1);
	assert.equal(cli.signal, null);
	assert.match(cli.stderr, /unexpected internal failure/);
});

test('scratch arithmetic must use the reviewed multiplier and remain a safe integer', () => {
	const wrongMultiplier = createFixture();
	rewriteBasis(wrongMultiplier, (basis) => {
		basis.authorizationBasis.storagePreflight.scratchMultiplier = 2.5;
	});
	assert.throws(
		() =>
			validateAuthorizationBasis({
				basisPath: wrongMultiplier.basisPath,
				outputPath: wrongMultiplier.outputPath
			}),
		/must equal the reviewed value 2/
	);

	const overflow = createFixture();
	rewriteBasis(overflow, (basis) => {
		basis.authorizationBasis.storagePreflight.projectedSmokePeakBytes =
			Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
	});
	assert.throws(
		() =>
			validateAuthorizationBasis({
				basisPath: overflow.basisPath,
				outputPath: overflow.outputPath
			}),
		/safe-integer range/
	);
});

test('synthetic execution performs exact upload, read, download, hash, delete, and absence chain', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	assert.equal(report.passed, true);
	assert.equal(report.failure, null);
	assert.deepEqual(
		report.commands.map((command) => command.operation),
		['put-object', 'head-object', 'get-object', 'delete-object', 'post-delete-head-object-1']
	);
	assert.deepEqual(
		report.commands.map((command) => command.exitCode),
		[0, 0, 0, 0, 254]
	);
	assert.equal(report.probe.source.sha256, report.probe.download.sha256);
	assert.equal(report.probe.checks.postDeleteAbsence, true);
	assert.equal(report.storage.probeKey.startsWith(report.derivedStoragePrefix), true);
	assert.equal(report.throughput.uploadBytesPerSecond, (4096 * 1000) / 25);
	assert.equal(report.throughput.downloadBytesPerSecond, (4096 * 1000) / 10);
	assert.equal(aws.objects.size, 0);
	assert.equal(lstatSync(fixture.outputPath).mode & 0o222, 0);
	assert.equal(readFileSync(fixture.outputPath, 'utf8').includes('SECRET'), false);
	assert.throws(() => lstatSync(fixture.attemptRoot), { code: 'ENOENT' });
	assert.equal(
		validateStoragePreflightReport({
			reportPath: fixture.outputPath,
			basisPath: fixture.basisPath,
			repo: fixture.root
		}).passed,
		true
	);
	for (const [key, value] of Object.entries(report.flags)) {
		assert.equal(value, key === 'storagePreflightOpen');
	}
	const put = report.commands[0];
	assert.equal(put.executable, '/synthetic/bin/aws');
	assert.equal(put.args.includes('--checksum-algorithm'), true);
	assert.equal(argument(put.args, '--if-none-match'), '*');
	assert.equal(argument(put.args, '--metadata'), `sha256=${report.probe.source.sha256}`);
});

test('strict report validator rejects changed execFile argv', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	const changed = JSON.parse(readFileSync(fixture.outputPath, 'utf8'));
	changed.commands[0].args.push('--endpoint-url', 'https://example.invalid');
	chmodSync(fixture.outputPath, 0o644);
	writeFileSync(fixture.outputPath, `${JSON.stringify(changed)}\n`);
	chmodSync(fixture.outputPath, 0o444);
	assert.throws(
		() =>
			validateStoragePreflightReport({
				reportPath: fixture.outputPath,
				basisPath: fixture.basisPath,
				repo: fixture.root
			}),
		/argv changed/
	);
});

test('download mismatch fails closed, deletes the object, and publishes sanitized evidence', async () => {
	const fixture = createFixture();
	const aws = syntheticAws({ corruptDownload: true });
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /downloaded probe bytes or SHA-256 changed/);
	assert.equal(report.probe.checks.downloadHash, false);
	assert.equal(report.probe.checks.delete, true);
	assert.equal(report.probe.checks.postDeleteAbsence, true);
	assert.equal(aws.objects.size, 0);
	assert.equal(readFileSync(fixture.outputPath, 'utf8').includes('SECRET'), false);
});

test('metadata mismatch fails closed and still removes the uploaded object', async () => {
	const fixture = createFixture();
	const aws = syntheticAws({ corruptMetadata: true });
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /metadata changed/);
	assert.equal(report.probe.checks.metadataRead, false);
	assert.equal(report.probe.checks.delete, true);
	assert.equal(aws.objects.size, 0);
});

test('ambiguous failed put is conservatively deleted and verified absent', async () => {
	const fixture = createFixture();
	const aws = syntheticAws({ failPutAfterStore: true });
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /put-object failed/);
	assert.equal(report.probe.checks.upload, false);
	assert.equal(report.probe.checks.delete, true);
	assert.equal(report.probe.checks.postDeleteAbsence, true);
	assert.equal(aws.objects.size, 0);
	assert.equal(readFileSync(fixture.outputPath, 'utf8').includes('SECRET'), false);
});

test('unexpected executor fields fail closed without leaking or orphaning the object', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	const deps = dependencies(aws);
	const originalExec = deps.execFile;
	deps.execFile = async (executable, args) => {
		const result = await originalExec(executable, args);
		return args[6] === 'put-object' ? { ...result, rawSecret: 'SECRET' } : result;
	};
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: deps
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /executor returned an invalid result/);
	assert.equal(report.probe.checks.delete, true);
	assert.equal(report.probe.checks.postDeleteAbsence, true);
	assert.equal(aws.objects.size, 0);
	assert.equal(readFileSync(fixture.outputPath, 'utf8').includes('SECRET'), false);
});

test('conditional-put collision never deletes the pre-existing object', async () => {
	const fixture = createFixture();
	const aws = syntheticAws({ putPreconditionFailed: true });
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /put-object failed/);
	assert.deepEqual(
		report.commands.map((command) => command.operation),
		['put-object']
	);
	assert.equal(report.probe.checks.delete, false);
	assert.equal(report.probe.checks.postDeleteAbsence, false);
	assert.equal(aws.objects.size, 1);
	assert.equal(readFileSync(fixture.outputPath, 'utf8').includes('preexisting-object'), false);
});

test('ambiguous failed delete is retried on the same key and verified absent', async () => {
	const fixture = createFixture();
	const aws = syntheticAws({ failFirstDeleteAfterDelete: true });
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /delete-object failed/);
	assert.equal(
		report.commands.filter((command) => command.operation === 'delete-object').length,
		2
	);
	assert.equal(report.probe.checks.delete, true);
	assert.equal(report.probe.checks.postDeleteAbsence, true);
	assert.equal(aws.objects.size, 0);
	assert.equal(readFileSync(fixture.outputPath, 'utf8').includes('SECRET'), false);
});

test('AccessDenied after delete is not accepted as absence and secret output is not recorded', async () => {
	const fixture = createFixture();
	const aws = syntheticAws({ postDeleteAccessDenied: true });
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws)
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /without NotFound evidence/);
	assert.equal(report.probe.checks.postDeleteAbsence, false);
	const serialized = readFileSync(fixture.outputPath, 'utf8');
	assert.equal(serialized.includes('SECRET'), false);
	assert.equal(serialized.includes('AccessDenied'), false);
});

test('scratch below two times projected peak blocks before any AWS command', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: dependencies(aws, { freeBytes: 32_767 })
	});
	assert.equal(report.passed, false);
	assert.match(report.failure.message, /less than twice the projected smoke peak/);
	assert.equal(report.scratch.requiredBytes, 32_768);
	assert.equal(report.commands.length, 0);
	assert.equal(aws.calls.length, 0);
});

test('failed postflight scratch measurement makes an otherwise successful probe fail closed', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	const deps = dependencies(aws);
	let measurements = 0;
	deps.measureFreeBytes = () => {
		measurements += 1;
		if (measurements === 1) return 1_000_000;
		throw new Error('SECRET scratch telemetry failure');
	};
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: deps
	});
	assert.equal(report.passed, false);
	assert.equal(report.failure.code, 'scratch-postflight-failed');
	assert.equal(report.scratch.freeBytesAfter, null);
	assert.equal(aws.objects.size, 0);
	assert.equal(readFileSync(fixture.outputPath, 'utf8').includes('SECRET'), false);
});

test('basis replacement during AWS execution invalidates the report', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	const deps = dependencies(aws);
	const originalExec = deps.execFile;
	deps.execFile = async (executable, args) => {
		const result = await originalExec(executable, args);
		if (args[6] === 'put-object' && result.exitCode === 0) {
			chmodSync(fixture.basisPath, 0o644);
			writeFileSync(fixture.basisPath, `${readFileSync(fixture.basisPath, 'utf8')} `);
			chmodSync(fixture.basisPath, 0o444);
		}
		return result;
	};
	const report = await runAuthorizedStoragePreflight({
		basisPath: fixture.basisPath,
		outputPath: fixture.outputPath,
		repo: fixture.root,
		mode: 'execute',
		dependencies: deps
	});
	assert.equal(report.passed, false);
	assert.equal(report.failure.code, 'authorization-basis-changed');
	assert.match(report.failure.message, /authorization basis changed after validation/);
	assert.equal(aws.objects.size, 0);
});

test('existing report, dangling report symlink, and existing attempt root fail before AWS execution', async () => {
	const existing = createFixture();
	writeFileSync(existing.outputPath, 'occupied');
	assert.throws(
		() =>
			validateAuthorizationBasis({
				basisPath: existing.basisPath,
				outputPath: existing.outputPath
			}),
		/already exists/
	);

	const dangling = createFixture();
	symlinkSync(path.join(dangling.root, 'missing-target'), dangling.outputPath);
	assert.throws(
		() =>
			validateAuthorizationBasis({
				basisPath: dangling.basisPath,
				outputPath: dangling.outputPath
			}),
		/already exists/
	);

	const attempt = createFixture();
	mkdirSync(attempt.attemptRoot);
	assert.throws(
		() =>
			validateAuthorizationBasis({ basisPath: attempt.basisPath, outputPath: attempt.outputPath }),
		/attemptRoot already exists/
	);
});

test('report publication is new-only under a race', async () => {
	const fixture = createFixture();
	const aws = syntheticAws();
	let freeChecks = 0;
	const deps = dependencies(aws);
	deps.measureFreeBytes = () => {
		freeChecks += 1;
		if (freeChecks === 2) writeFileSync(fixture.outputPath, 'raced');
		return 1_000_000;
	};
	await assert.rejects(
		() =>
			runAuthorizedStoragePreflight({
				basisPath: fixture.basisPath,
				outputPath: fixture.outputPath,
				repo: fixture.root,
				mode: 'execute',
				dependencies: deps
			}),
		/(?:EEXIST|file already exists)/
	);
	assert.equal(readFileSync(fixture.outputPath, 'utf8'), 'raced');
	assert.equal(aws.objects.size, 0);
});

let passed = 0;
try {
	for (const row of tests) {
		try {
			await row.fn();
			passed += 1;
			console.log(`ok ${passed} - ${row.name}`);
		} catch (error) {
			console.error(`not ok ${passed + 1} - ${row.name}`);
			throw error;
		}
	}
	console.log(`1..${tests.length}`);
} finally {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
}
