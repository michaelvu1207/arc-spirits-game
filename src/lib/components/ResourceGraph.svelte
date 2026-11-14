<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		Chart,
		LineController,
		LineElement,
		PointElement,
		LinearScale,
		CategoryScale,
		Title,
		Tooltip,
		Legend,
		type ChartConfiguration,
		type ActiveElement,
		type ChartEvent
	} from 'chart.js';

	// Register Chart.js components
	Chart.register(
		LineController,
		LineElement,
		PointElement,
		LinearScale,
		CategoryScale,
		Title,
		Tooltip,
		Legend
	);

	// Player color mapping — saturated brand palette identity colors
	const CHART_COLORS: Record<string, string> = {
		Red: '#ff4d6d',     // --color-blood
		Blue: '#24d4ff',    // --brand-cyan
		Orange: '#ff704d',  // --brand-coral
		Green: '#20e0c1',   // --brand-teal
		Purple: '#ff2bc7',  // --brand-magenta
		Yellow: '#ffba3d'   // --brand-amber
	};

	interface GraphDataPoint {
		round: number;
		players: Array<{ color: string; blood: number; victoryPoints: number; barrier: number }>;
	}

	interface Props {
		type: 'victoryPoints' | 'brokenBarrier' | 'barrier' | 'barrierGained';
		data: GraphDataPoint[];
		currentRound: number;
		onRoundClick?: (round: number) => void;
		/** The game explorer's plain look: thin lines, no points, neutral axes. */
		plain?: boolean;
	}

	let { type, data, currentRound, onRoundClick, plain = false }: Props = $props();

	let canvasElement: HTMLCanvasElement;
	let chartInstance: Chart | null = null;

	// Derive chart title based on type
	const chartTitle = $derived(
		type === 'victoryPoints'
			? 'Victory Points'
			: type === 'brokenBarrier'
				? 'Broken Barrier'
				: type === 'barrierGained'
					? 'Total Barrier Gained'
					: 'Barrier'
	);

	// Calculate cumulative barrier gained for each player
	const barrierGainedByPlayer = $derived(() => {
		if (type !== 'barrierGained') return new Map<string, number[]>();

		const result = new Map<string, number[]>();
		const prevBarrier = new Map<string, number>();

		data.forEach((round, roundIndex) => {
			round.players.forEach((player) => {
				if (!result.has(player.color)) {
					result.set(player.color, []);
				}

				const prev = prevBarrier.get(player.color) ?? 0;
				const gained = Math.max(0, player.barrier - prev);
				const cumulative =
					roundIndex === 0 ? gained : (result.get(player.color)?.at(-1) ?? 0) + gained;

				result.get(player.color)!.push(cumulative);
				prevBarrier.set(player.color, player.barrier);
			});
		});

		return result;
	});

	// Get unique player colors from data
	const playerColors = $derived(() => {
		if (data.length === 0) return [];
		const colors = new Set<string>();
		data.forEach((round) => {
			round.players.forEach((player) => {
				colors.add(player.color);
			});
		});
		return Array.from(colors).sort();
	});

	// Build datasets for each player
	const datasets = $derived(() => {
		const colors = playerColors();
		return colors.map((color) => {
			let playerData: (number | null)[];

			if (type === 'barrierGained') {
				playerData = barrierGainedByPlayer().get(color) ?? data.map(() => null);
			} else {
				playerData = data.map((round) => {
					const player = round.players.find((p) => p.color === color);
					if (!player) return null;
					if (type === 'brokenBarrier') return player.blood;
					if (type === 'victoryPoints') return player.victoryPoints;
					return player.barrier;
				});
			}

			return {
				label: color,
				data: playerData,
				borderColor: CHART_COLORS[color] ?? '#888888',
				backgroundColor: CHART_COLORS[color] ?? '#888888',
				borderWidth: plain ? 1.5 : 2,
				pointRadius: plain ? 0 : 4,
				pointHoverRadius: plain ? 3 : 6,
				tension: 0.1,
				spanGaps: true
			};
		});
	});

	// X-axis labels (round numbers)
	const labels = $derived(data.map((d) => `R${d.round}`));

	// Custom plugin for current round vertical line indicator
	const currentRoundLinePlugin = {
		id: 'currentRoundLine',
		afterDraw(chart: Chart) {
			if (data.length === 0) return;

			const roundIndex = data.findIndex((d) => d.round === currentRound);
			if (roundIndex === -1) return;

			const { ctx, chartArea, scales } = chart;
			const xScale = scales.x;

			if (!xScale || !chartArea) return;

			const x = xScale.getPixelForValue(roundIndex);

			ctx.save();
			ctx.beginPath();
			ctx.moveTo(x, chartArea.top);
			ctx.lineTo(x, chartArea.bottom);
			ctx.lineWidth = 2;
			ctx.strokeStyle = plain ? '#9a9eab' : 'rgba(255, 43, 199, 0.75)';
			ctx.setLineDash([5, 5]);
			ctx.stroke();
			ctx.restore();

			// Draw a small triangle indicator at the top
			ctx.save();
			ctx.beginPath();
			ctx.moveTo(x, chartArea.top - 5);
			ctx.lineTo(x - 6, chartArea.top - 12);
			ctx.lineTo(x + 6, chartArea.top - 12);
			ctx.closePath();
			ctx.fillStyle = plain ? '#9a9eab' : 'rgba(255, 43, 199, 0.9)';
			ctx.fill();
			ctx.restore();
		}
	};

	// Handle click on chart
	function handleChartClick(event: ChartEvent, elements: ActiveElement[], chart: Chart) {
		if (!onRoundClick) return;

		if (elements.length > 0) {
			const index = elements[0].index;
			const round = data[index]?.round;
			if (round !== undefined) {
				onRoundClick(round);
			}
		} else {
			// Allow clicking on the x-axis area to navigate
			const xScale = chart.scales.x;
			if (xScale && event.x !== null) {
				const value = xScale.getValueForPixel(event.x as number);
				if (value !== undefined && value >= 0 && value < data.length) {
					const roundIndex = Math.round(value as number);
					const round = data[roundIndex]?.round;
					if (round !== undefined) {
						onRoundClick(round);
					}
				}
			}
		}
	}

	// Chart configuration
	function getChartConfig(): ChartConfiguration<'line'> {
		return {
			type: 'line',
			data: {
				labels: labels,
				datasets: datasets()
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				interaction: {
					mode: 'index',
					intersect: false
				},
				onClick: handleChartClick,
				plugins: {
					legend: {
						display: true,
						position: 'top',
						labels: {
							color: '#d8cfee',   // --color-parchment
							font: {
								size: 11,
								family: "'Inter', system-ui, sans-serif"
							},
							usePointStyle: true,
							pointStyle: 'circle',
							padding: 14
						}
					},
					title: {
						display: true,
						text: chartTitle,
						color: '#f5f0ff',   // --color-bone
						font: {
							size: 13,
							weight: 'bold',
							family: "'Bebas Neue', 'Impact', serif"
						},
						padding: {
							top: 8,
							bottom: 12
						}
					},
					tooltip: {
						backgroundColor: 'rgba(26, 15, 46, 0.97)',  // --color-crypt
						titleColor: '#f5f0ff',
						bodyColor: '#d8cfee',
						borderColor: 'rgba(123, 29, 255, 0.5)',     // --brand-violet
						borderWidth: 1,
						padding: 12,
						displayColors: true,
						callbacks: {
							title: (items) => {
								if (items.length > 0) {
									return `Round ${data[items[0].dataIndex]?.round ?? items[0].dataIndex + 1}`;
								}
								return '';
							},
							label: (context) => {
								const label = context.dataset.label ?? '';
								const value = context.parsed.y;
								const unit =
									type === 'brokenBarrier'
										? ' broken barrier'
										: type === 'victoryPoints'
											? ' VP'
											: type === 'barrierGained'
												? ' barrier gained'
												: ' barrier';
								return `${label}: ${value}${unit}`;
							}
						}
					}
				},
				scales: {
					x: {
						grid: {
							color: 'rgba(46, 29, 82, 0.6)',   // --color-mist transparent
							lineWidth: 1
						},
						ticks: {
							color: '#9a8fb8',   // --color-fog
							font: {
								size: 10
							},
							maxRotation: 0
						},
						border: {
							color: 'rgba(46, 29, 82, 0.8)'
						}
					},
					y: {
						beginAtZero: true,
						grid: {
							color: 'rgba(46, 29, 82, 0.6)',
							lineWidth: 1
						},
						ticks: {
							color: '#9a8fb8',
							font: {
								size: 10
							},
							stepSize:
								type === 'victoryPoints' || type === 'barrier' || type === 'barrierGained'
									? 1
									: undefined
						},
						border: {
							color: 'rgba(46, 29, 82, 0.8)'
						}
					}
				},
				elements: {
					point: {
						hoverBorderWidth: 2,
						hoverBorderColor: '#ffffff'
					}
				}
			},
			plugins: [currentRoundLinePlugin]
		};
	}

	// Create chart on mount
	onMount(() => {
		if (canvasElement) {
			const config = getChartConfig();
			if (plain) {
				const text = '#9a9eab';
				const line = '#23262f';
				const font = { family: "'Figtree', system-ui, sans-serif", size: 12, weight: 500 as const };
				const plugins = config.options?.plugins as Record<string, { color?: string; font?: unknown; labels?: { color?: string; font?: unknown; boxWidth?: number; boxHeight?: number } }> | undefined;
				if (plugins?.title) Object.assign(plugins.title, { color: '#e6e7eb', font });
				if (plugins?.legend?.labels) Object.assign(plugins.legend.labels, { color: text, font, boxWidth: 6, boxHeight: 6 });
				for (const axis of Object.values((config.options?.scales ?? {}) as Record<string, { grid?: { color?: string }; ticks?: { color?: string }; border?: { color?: string } }>)) {
					if (axis.grid) axis.grid.color = line;
					if (axis.ticks) axis.ticks.color = text;
					if (axis.border) axis.border.color = line;
				}
			}
			chartInstance = new Chart(canvasElement, config);
		}
	});

	// Update chart when data changes
	$effect(() => {
		if (chartInstance) {
			chartInstance.data.labels = labels;
			chartInstance.data.datasets = datasets();
			if (chartInstance.options.plugins?.title) {
				(chartInstance.options.plugins.title as { text: string }).text = chartTitle;
			}
			chartInstance.update('none');
		}
	});

	// Update chart when currentRound changes (for the vertical line)
	$effect(() => {
		// Access currentRound to create dependency
		const _ = currentRound;
		if (chartInstance) {
			chartInstance.update('none');
		}
	});

	// Cleanup on destroy
	onDestroy(() => {
		if (chartInstance) {
			chartInstance.destroy();
			chartInstance = null;
		}
	});
</script>

<div class="resource-graph-container">
	<canvas bind:this={canvasElement}></canvas>
</div>

<style>
	.resource-graph-container {
		width: 100%;
		height: 220px;
		background: var(--color-shadow);
		border-radius: 12px;
		padding: 0.75rem;
		border: 1px solid var(--color-mist);
	}

	canvas {
		width: 100% !important;
		height: 100% !important;
		cursor: pointer;
	}
</style>
