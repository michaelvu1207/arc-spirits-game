#!/usr/bin/env node
import { spawn } from 'node:child_process';

const stages = new Map([
	[
		'engine',
		[
			['npm', ['run', 'check']],
			['npm', ['test']],
			[
				'npx',
				[
					'vitest',
					'run',
					'src/lib/play/ml/_canApply.test.ts',
					'src/lib/play/sim/_parity.test.ts',
					'--disable-console-intercept'
				]
			]
		]
	],
	[
		'ml-smoke',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_gen.test.ts', '--disable-console-intercept'],
				{
					GEN: '1',
					GEN_MODE: 'heur',
					GEN_GAMES: '2',
					GEN_SAMPLE: '1',
					GEN_MAXROUNDS: '30',
					GEN_OUT: 'ml/data_smoke/gen_neural.jsonl',
					ML_META_PATH: 'ml/data_smoke/meta.json'
				}
			],
			[
				'ml/.venv/bin/python',
				[
					'ml/train.py',
					'--data',
					'ml/data_smoke',
					'--out',
					'ml/weights/policy-smoke.json',
					'--epochs',
					'1',
					'--batch-size',
					'128'
				],
				{ EPOCHS: '1', BATCH: '128' }
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_eval.test.ts', '--disable-console-intercept'],
				{
					EVAL: '1',
					EVAL_GAMES: '2',
					EVAL_OPPONENTS: 'mixed',
					EVAL_MAXROUNDS: '30',
					EVAL_WEIGHTS: 'ml/weights/policy-smoke.json'
				}
			]
		]
	],
	[
		'az-smoke',
		[
			[
				'bash',
				['ml/discover_meta.sh'],
				{
					RUN_ID: 'smoke',
					OUTER: '1',
					GAMES: '1',
					SHARDS: '1',
					MCTS: '4',
					EPOCHS: '1',
					META_GAMES: '1',
					META_MCTS: '4',
					npm_config_prefix: null,
					NPM_CONFIG_PREFIX: null
				}
			]
		]
	],
	[
		'abyss-route',
		[
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_abyssroute.test.ts', '--disable-console-intercept'],
				{
					ABYSSROUTE: '1',
					ABYSSROUTE_GAMES: '8',
					ABYSSROUTE_DICE_COUNTS: '0,1,2'
				}
			]
		]
	],
	[
		'abyss-curriculum',
		[
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_abysscurriculum.test.ts', '--disable-console-intercept'],
				{
					ABYSSCURRICULUM: '1',
					ABYSSCURRICULUM_GAMES: '1',
					ABYSSCURRICULUM_DICE_COUNTS: '6',
					ABYSSCURRICULUM_MAX_BARRIERS: '12',
					ABYSSCURRICULUM_SPIRIT_ANIMALS: '2',
					ABYSSCURRICULUM_DATA_DIR: 'ml/data_abyss_curriculum_smoke'
				}
			]
		]
	],
	[
		'clean-farm',
		[
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_cleanfarm.test.ts', '--disable-console-intercept'],
				{
					CLEANFARM: '1',
					CLEANFARM_GAMES: '4',
					CLEANFARM_SEATS: '4',
					CLEANFARM_PROFILES: 'paragon,farmer,farmer2,hard',
					CLEANFARM_OUT: 'ml/cleanfarm_result.json'
				}
			]
		]
	],
	[
		'clean-farm-curriculum',
		[
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_cleanfarmcurriculum.test.ts', '--disable-console-intercept'],
				{
					CLEANFARMCURRICULUM: '1',
					CLEANFARMCURRICULUM_GAMES: '1',
					CLEANFARMCURRICULUM_SEATS: '4',
					CLEANFARMCURRICULUM_PROFILES: 'paragon,farmer,farmer2,hard',
					CLEANFARMCURRICULUM_DATA_DIR: 'ml/data_cleanfarm_curriculum_smoke'
				}
			]
		]
	],
	[
		'farm-counterfactual',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_farmq_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_farmq_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_farmcounterfactual.test.ts', '--disable-console-intercept'],
				{
					FARMQ: '1',
					FARMQ_GAMES: '1',
					FARMQ_MAX_WINDOWS: '4',
					FARMQ_HORIZONS: '3,6',
					FARMQ_LABEL_HORIZON: '6',
					FARMQ_DATA_OUT: 'ml/data_farmq_smoke/farmq.jsonl',
					FARMQ_OUT: 'ml/farmq_counterfactual_smoke.json',
					FARMQ_SUMMARY: 'ml/farmq_counterfactual_smoke_summary.json'
				}
			]
		]
	],
	[
		'clean-route-proof',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_clean_route_proof_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_clean_route_proof_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_farmcounterfactual.test.ts', '--disable-console-intercept'],
				{
					FARMQ: '1',
					FARMQ_GAMES: '2',
					FARMQ_MAX_WINDOWS: '12',
					FARMQ_HORIZONS: '3,6,10',
					FARMQ_LABEL_HORIZON: '10',
					FARMQ_DATA_OUT: 'ml/data_clean_route_proof_smoke/farmq.jsonl',
					FARMQ_OUT: 'ml/data_clean_route_proof_smoke/farmq.json',
					FARMQ_SUMMARY: 'ml/data_clean_route_proof_smoke/farmq_summary.json',
					FARMQ_FORBID_TYPES: 'initiatePvp',
					FARMQ_MAX_STATUS_LEVEL: '0'
				}
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_contractaudit.test.ts', '--disable-console-intercept'],
				{
					CONTRACTAUDIT: '1',
					CONTRACTAUDIT_DATA: 'ml/data_clean_route_proof_smoke/farmq.jsonl',
					CONTRACTAUDIT_OUT: 'ml/data_clean_route_proof_smoke/contract_audit_summary.json',
					CONTRACTAUDIT_MIN_ROWS: '8',
					CONTRACTAUDIT_MIN_LABELS: '2'
				}
			],
			[
				'ml/.venv/bin/python',
				[
					'ml/route_imitation.py',
					'--data',
					'ml/data_clean_route_proof_smoke',
					'--out',
					'ml/data_clean_route_proof_smoke/route_imitation_summary.json',
					'--epochs',
					'80',
					'--batch-size',
					'16',
					'--min-val-top1',
					'0.4',
					'--min-val-top3',
					'0.8',
					'--min-train-top1',
					'0.6'
				]
			]
		]
	],
	[
		'clean-route-beam',
		[
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_cleanroutebeam.test.ts', '--disable-console-intercept'],
				{
					ROUTEORACLE: '1',
					ROUTEORACLE_GAMES: '1',
					ROUTEORACLE_BEAM: '6',
					ROUTEORACLE_ACTION_BEAM: '8',
					ROUTEORACLE_MAX_TARGET_DECISIONS: '40',
					ROUTEORACLE_OUT: 'ml/clean_route_beam_smoke.json',
					ROUTEORACLE_SUMMARY: 'ml/clean_route_beam_smoke_summary.json'
				}
			]
		]
	],
	[
		'survival-counterfactual',
		[
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_survivalcounterfactual.test.ts', '--disable-console-intercept'],
				{
					SURVIVALQ: '1',
					SURVIVALQ_GAMES: '1',
					SURVIVALQ_MAX_WINDOWS: '4',
					SURVIVALQ_HORIZONS: '3,6',
					SURVIVALQ_LABEL_HORIZON: '6',
					SURVIVALQ_OUT: 'ml/survivalq_counterfactual_smoke.json',
					SURVIVALQ_SUMMARY: 'ml/survivalq_counterfactual_smoke_summary.json'
				}
			]
		]
	],
	[
		'route-execution-counterfactual',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_routeexecq_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_routeexecq_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_routeexecutioncounterfactual.test.ts', '--disable-console-intercept'],
				{
					ROUTEEXECQ: '1',
					ROUTEEXECQ_GAMES: '1',
					ROUTEEXECQ_MAX_WINDOWS: '4',
					ROUTEEXECQ_HORIZONS: '3,6',
					ROUTEEXECQ_LABEL_HORIZON: '6',
					ROUTEEXECQ_OUT: 'ml/routeexecq_counterfactual_smoke.json',
					ROUTEEXECQ_SUMMARY: 'ml/routeexecq_counterfactual_smoke_summary.json',
					ROUTEEXECQ_DATA_OUT: 'ml/data_routeexecq_smoke/routeexecq.jsonl'
				}
			]
		]
	],
	[
		'scaling-navigation-counterfactual',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_scalingq_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_scalingq_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_scalingnavigationcounterfactual.test.ts', '--disable-console-intercept'],
				{
					SCALEQ: '1',
					SCALEQ_SOURCE: 'heuristic',
					SCALEQ_GAMES: '1',
					SCALEQ_MAX_WINDOWS: '4',
					SCALEQ_HORIZONS: '3,6',
					SCALEQ_LABEL_HORIZON: '6',
					SCALEQ_MIN_PLAYER_VP: '0',
					SCALEQ_MIN_ROUND: '0',
					SCALEQ_OUT: 'ml/scalingq_counterfactual_smoke.json',
					SCALEQ_SUMMARY: 'ml/scalingq_counterfactual_smoke_summary.json',
					SCALEQ_DATA_OUT: 'ml/data_scalingq_smoke/scalingq.jsonl'
				}
			]
		]
	],
	[
		'hp4-wall-counterfactual',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_hp4_wall_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_hp4_wall_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_scalingnavigationcounterfactual.test.ts', '--disable-console-intercept'],
				{
					SCALEQ: '1',
					SCALEQ_SOURCE: 'heuristic',
					SCALEQ_GAMES: '2',
					SCALEQ_MAX_WINDOWS: '4',
					SCALEQ_HORIZONS: '6,12',
					SCALEQ_SELECT_HORIZON: '12',
					SCALEQ_LABEL_HORIZON: '12',
					SCALEQ_MIN_PLAYER_VP: '9',
					SCALEQ_MAX_PLAYER_VP: '24',
					SCALEQ_MIN_MONSTER_HP: '4',
					SCALEQ_MAX_MONSTER_HP: '4',
					SCALEQ_OUT: 'ml/hp4wall_scalingq_smoke.json',
					SCALEQ_SUMMARY: 'ml/hp4wall_scalingq_smoke_summary.json',
					SCALEQ_DATA_OUT: 'ml/data_hp4_wall_smoke/scaling/scalingq.jsonl'
				}
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_routeexecutioncounterfactual.test.ts', '--disable-console-intercept'],
				{
					ROUTEEXECQ: '1',
					ROUTEEXECQ_SOURCE: 'heuristic',
					ROUTEEXECQ_GAMES: '2',
					ROUTEEXECQ_MAX_WINDOWS: '4',
					ROUTEEXECQ_HORIZONS: '6,12',
					ROUTEEXECQ_SELECT_HORIZON: '12',
					ROUTEEXECQ_LABEL_HORIZON: '12',
					ROUTEEXECQ_MIN_PLAYER_VP: '9',
					ROUTEEXECQ_MAX_PLAYER_VP: '24',
					ROUTEEXECQ_MIN_MONSTER_HP: '4',
					ROUTEEXECQ_MAX_MONSTER_HP: '4',
					ROUTEEXECQ_OUT: 'ml/hp4wall_routeexecq_smoke.json',
					ROUTEEXECQ_SUMMARY: 'ml/hp4wall_routeexecq_smoke_summary.json',
					ROUTEEXECQ_DATA_OUT: 'ml/data_hp4_wall_smoke/routeexec/routeexecq.jsonl'
				}
			]
		]
	],
	[
		'hp4-wall-oracle',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_hp4_wall_oracle_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_hp4_wall_oracle_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_scalingnavigationcounterfactual.test.ts', '--disable-console-intercept'],
				{
					SCALEQ: '1',
					SCALEQ_SOURCE: 'heuristic',
					SCALEQ_ROLLOUT_POLICY: 'breakpoint-oracle',
					SCALEQ_GAMES: '2',
					SCALEQ_MAX_WINDOWS: '4',
					SCALEQ_HORIZONS: '6,12',
					SCALEQ_SELECT_HORIZON: '12',
					SCALEQ_LABEL_HORIZON: '12',
					SCALEQ_MIN_PLAYER_VP: '9',
					SCALEQ_MAX_PLAYER_VP: '24',
					SCALEQ_MIN_MONSTER_HP: '4',
					SCALEQ_MAX_MONSTER_HP: '4',
					SCALEQ_OUT: 'ml/hp4wall_oracle_scalingq_smoke.json',
					SCALEQ_SUMMARY: 'ml/hp4wall_oracle_scalingq_smoke_summary.json',
					SCALEQ_DATA_OUT: 'ml/data_hp4_wall_oracle_smoke/scaling/scalingq.jsonl'
				}
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_routeexecutioncounterfactual.test.ts', '--disable-console-intercept'],
				{
					ROUTEEXECQ: '1',
					ROUTEEXECQ_SOURCE: 'heuristic',
					ROUTEEXECQ_ROLLOUT_POLICY: 'breakpoint-oracle',
					ROUTEEXECQ_GAMES: '2',
					ROUTEEXECQ_MAX_WINDOWS: '4',
					ROUTEEXECQ_HORIZONS: '6,12',
					ROUTEEXECQ_SELECT_HORIZON: '12',
					ROUTEEXECQ_LABEL_HORIZON: '12',
					ROUTEEXECQ_MIN_PLAYER_VP: '9',
					ROUTEEXECQ_MAX_PLAYER_VP: '24',
					ROUTEEXECQ_MIN_MONSTER_HP: '4',
					ROUTEEXECQ_MAX_MONSTER_HP: '4',
					ROUTEEXECQ_OUT: 'ml/hp4wall_oracle_routeexecq_smoke.json',
					ROUTEEXECQ_SUMMARY: 'ml/hp4wall_oracle_routeexecq_smoke_summary.json',
					ROUTEEXECQ_DATA_OUT: 'ml/data_hp4_wall_oracle_smoke/routeexec/routeexecq.jsonl'
				}
			]
		]
	],
	[
		'trace-state-counterfactual',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_trace_state_smoke',{recursive:true,force:true}); fs.mkdirSync('ml/data_trace_state_smoke',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_tracestatecounterfactual.test.ts', '--disable-console-intercept'],
				{
					TRACEQ: '1',
					TRACEQ_GAMES: '1',
					TRACEQ_MAX_WINDOWS: '2',
					TRACEQ_HORIZONS: '3,6',
					TRACEQ_LABEL_HORIZON: '6',
					TRACEQ_MIN_SOURCE_VP: '0',
					TRACEQ_MAX_SOURCE_VP: '99',
					TRACEQ_MIN_PLAYER_VP: '0',
					TRACEQ_MAX_PLAYER_VP: '99',
					TRACEQ_MIN_ROUND: '0',
					TRACEQ_MIN_MONSTER_HP: '1',
					TRACEQ_MAX_CLEAN_KILL_PROB: '1',
					TRACEQ_SCRIPTS: 'policy,abyss-probe,restore-loop,max-barrier-loop,damage-assembly,hp4-survival-oracle,finish-line-oracle,fixed-reentry',
					TRACEQ_ITERS: '8',
					TRACEQ_PLANNER_HORIZON: '8',
					TRACEQ_OUT: 'ml/data_trace_state_smoke/trace_state_counterfactual.json',
					TRACEQ_SUMMARY: 'ml/data_trace_state_smoke/trace_state_counterfactual_summary.json',
					TRACEQ_DATA_OUT: 'ml/data_trace_state_smoke/traceq.jsonl',
					TRACEQ_POSITIVE_ONLY_DATA: '1'
				}
			]
		]
	],
	[
		'contract-audit',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_contract_audit',{recursive:true,force:true}); fs.mkdirSync('ml/data_contract_audit',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_survivalcounterfactual.test.ts', '--disable-console-intercept'],
				{
					SURVIVALQ: '1',
					SURVIVALQ_GAMES: '4',
					SURVIVALQ_MAX_WINDOWS: '24',
					SURVIVALQ_HORIZONS: '3,6,10',
					SURVIVALQ_LABEL_HORIZON: '10',
					SURVIVALQ_OUT: 'ml/data_contract_audit/survivalq.json',
					SURVIVALQ_SUMMARY: 'ml/data_contract_audit/survivalq_summary.json',
					SURVIVALQ_DATA_OUT: 'ml/data_contract_audit/survivalq.jsonl'
				}
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_contractaudit.test.ts', '--disable-console-intercept'],
				{
					CONTRACTAUDIT: '1',
					CONTRACTAUDIT_DATA: 'ml/data_contract_audit/survivalq.jsonl',
					CONTRACTAUDIT_OUT: 'ml/data_contract_audit/contract_audit_summary.json',
					CONTRACTAUDIT_MIN_ROWS: '8',
					CONTRACTAUDIT_MIN_LABELS: '2'
				}
			]
		]
	],
	[
		'route-imitation',
		[
			[
				'node',
				[
					'-e',
					"const fs=require('node:fs'); fs.rmSync('ml/data_route_imitation',{recursive:true,force:true}); fs.mkdirSync('ml/data_route_imitation',{recursive:true});"
				]
			],
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/_survivalcounterfactual.test.ts', '--disable-console-intercept'],
				{
					SURVIVALQ: '1',
					SURVIVALQ_GAMES: '4',
					SURVIVALQ_MAX_WINDOWS: '24',
					SURVIVALQ_HORIZONS: '3,6,10',
					SURVIVALQ_LABEL_HORIZON: '10',
					SURVIVALQ_OUT: 'ml/data_route_imitation/survivalq.json',
					SURVIVALQ_SUMMARY: 'ml/data_route_imitation/survivalq_summary.json',
					SURVIVALQ_DATA_OUT: 'ml/data_route_imitation/survivalq.jsonl'
				}
			],
			[
				'ml/.venv/bin/python',
				[
					'ml/route_imitation.py',
					'--data',
					'ml/data_route_imitation',
					'--out',
					'ml/data_route_imitation/route_imitation_summary.json',
					'--epochs',
					'160',
					'--batch-size',
					'32',
					'--lr',
					'0.001',
					'--min-val-top1',
					'0.6',
					'--min-val-top3',
					'0.9',
					'--min-train-top1',
					'0.8'
				]
			]
		]
	],
	[
		'strict-constraints',
		[
			[
				'npx',
				['vitest', 'run', 'src/lib/play/ml/strictConstraints.test.ts', '--disable-console-intercept']
			]
		]
	],
	[
		'browser',
		[
			['npm', ['run', 'test:e2e', '--', 'e2e/play-p0.spec.ts']],
			['npm', ['run', 'test:e2e', '--', 'e2e/mobile-perf-smoke.spec.ts']]
		]
	]
]);

const requested = process.argv.slice(2);
const selected = requested.length > 0 ? requested : ['engine'];

for (const name of selected) {
	if (!stages.has(name)) {
		console.error(`Unknown gate stage: ${name}`);
		console.error(`Known stages: ${[...stages.keys()].join(', ')}`);
		process.exit(2);
	}
}

for (const name of selected) {
	console.log(`\n== bot-test-gate:${name} ==`);
	for (const [cmd, args, env = {}] of stages.get(name)) {
		await run(cmd, args, env);
	}
}

function run(cmd, args, env) {
	return new Promise((resolve, reject) => {
		console.log(`$ ${cmd} ${args.join(' ')}`);
		const childEnv = { ...process.env };
		for (const [key, value] of Object.entries(env)) {
			if (value == null) delete childEnv[key];
			else childEnv[key] = String(value);
		}
		const child = spawn(cmd, args, {
			stdio: 'inherit',
			env: childEnv
		});
		child.on('exit', (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} exited with ${code ?? signal}`));
		});
		child.on('error', reject);
	});
}
