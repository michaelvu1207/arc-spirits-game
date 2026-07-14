#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateProtocol } from './validate-v34-lane-b-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protocolPath = path.join(
	root,
	'ml/experiments/v34-latency-first-expert-iteration/lane-b-execution-protocol.json'
);
const baseline = JSON.parse(readFileSync(protocolPath, 'utf8'));
const clone = () => structuredClone(baseline);
const rejects = (mutate, pattern = /protocol|closed|changed|must remain|differs/) => {
	const fixture = clone();
	mutate(fixture);
	assert.throws(() => validateProtocol(fixture), pattern);
};

const valid = validateProtocol(clone());
assert.equal(valid.valid, true);
assert.equal(valid.registeredRanges, 38);
assert.equal(valid.registeredSeedsOpen, false);
assert.equal(valid.unresolvedAmbiguities, 8);

rejects((value) => {
	value.unreviewedField = true;
}, /root keys changed/);

rejects((value) => {
	value.b1.stageOpen = true;
}, /b1 must remain closed/);

rejects((value) => {
	value.seedLedger[0].seedMax += 1;
}, /range changed|count is inconsistent/);

rejects((value) => {
	value.seedLedger[0].extra = true;
}, /keys changed/);

rejects((value) => {
	value.seedLedger[1].seed0 = value.seedLedger[0].seedMax;
}, /range changed|overlap/);

rejects((value) => {
	value.b1.selection.generationSeeds.g1 += 1;
}, /deepStrictEqual|differs|Expected values/);

rejects((value) => {
	value.b3.permutations.seeds.g2.epoch2.teacher += 1;
}, /permutation seed changed/);

rejects((value) => {
	value.b5.soloRegression.pcg64Seed += 1;
}, /Expected values|differs/);

rejects((value) => {
	value.retry.retryableFailures['server-start'] = 91;
}, /deepStrictEqual|differs|Expected values/);

rejects((value) => {
	value.storage.objectStore.uriTemplate = 's3://wrong/prefix/';
}, /Expected values|differs/);

rejects((value) => {
	value.storage.scratch.durable = true;
}, /Expected values|differs/);

rejects((value) => {
	value.validationMetadata.ambiguities.pop();
}, /deepStrictEqual|differs|Expected values/);

rejects((value) => {
	value.b5.finalHidden.exactScheduleSpecified = true;
}, /Expected values|differs/);

rejects((value) => {
	value.authorization.productionPromotionOpen = true;
}, /must remain false/);

rejects((value) => {
	value.result = {};
}, /Expected values|differs/);

console.log(
	JSON.stringify({
		schemaVersion: 'arc-v34-lane-b-protocol-test-v1',
		passed: 16,
		fixtures: 'synthetic-only',
		registeredSeedsConsumed: false,
		outcomesRead: false,
		gpuTouched: false
	})
);
