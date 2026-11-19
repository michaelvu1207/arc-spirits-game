<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount, onDestroy, type Snippet } from 'svelte';
	import GameViewer from '$lib/components/GameViewer.svelte';
	import ErrorDisplay from '$lib/components/ErrorDisplay.svelte';
	import ResourceGraph from '$lib/components/ResourceGraph.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import GameNotes from '$lib/components/GameNotes.svelte';
	import RoundBagsPanel from '$lib/components/RoundBagsPanel.svelte';
	import HostNotesEditor from '$lib/components/HostNotesEditor.svelte';
	import PlayerFeedbackForm from '$lib/components/PlayerFeedbackForm.svelte';
	import { toFullReplayCode, toShortReplayCode } from '$lib/replayCodes';
	import {
		loadGame,
		cleanup,
		getGameState,
		goToRound,
		toggleLive,
		acknowledgeNewData,
		getGraphData,
		refreshGameNotes,
		refreshPlayerFeedback
	} from '$lib/stores/gameStore.svelte';
	import { loadAssets, getAssetState } from '$lib/stores/assetStore.svelte';
	import { STORAGE_BASE_URL } from '$lib/supabase';
	import { explorerLinks, fetchGameStories, fetchRoundHands, type GameStory, type RoundHand } from '$lib/explorer';

	interface Props {
		data: {
			gameId: string;
			isAdmin: boolean;
			taggingConfigError: string | null;
			compositionTagsByColor: Record<string, string[]>;
			tagOptions: string[];
		};
		form?: { error?: string } | null;
		/** The local game explorer: one screen, a short bar, and the time-lapse. */
		explorer?: boolean;
		/**
		 * Explorer, test games: the rules this game was played under, where they differ from the
		 * live game. Shown as its own tab; the cards in the viewer are the live game's.
		 */
		rules?: Snippet;
	}

	let { data, form, explorer = false, rules }: Props = $props();

	// Time-lapse: the rounds play by themselves, from the round shown to the last one.
	let roundHands = $state(new Map<string, RoundHand>());
	let story = $state<GameStory | null>(null);
	$effect(() => {
		if (!explorer) return;
		void fetchRoundHands(data.gameId).then((hands) => (roundHands = hands));
		void fetchGameStories(data.gameId).then((stories) => (story = stories.get(data.gameId) ?? null));
	});
	const LAPSE_SPEEDS = [1, 2, 4];
	let lapsePlaying = $state(false);
	let lapseSpeed = $state(1);

	function toggleLapse() {
		if (!lapsePlaying && gameState.navigationCount >= gameState.maxNavigation) goToRound(1);
		lapsePlaying = !lapsePlaying;
	}

	$effect(() => {
		if (!lapsePlaying) return;
		const timer = setInterval(() => {
			if (gameState.navigationCount >= gameState.maxNavigation) lapsePlaying = false;
			else goToRound(gameState.navigationCount + 1);
		}, 900 / lapseSpeed);
		return () => clearInterval(timer);
	});

	/** Space: play or pause. Left and right: one round back or forward. */
	function handleLapseKeys(event: KeyboardEvent) {
		if (!explorer || activeTab !== 'round') return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('input:not([type=range]), textarea, select, button, a')) return;
		if (event.key === ' ') {
			event.preventDefault();
			toggleLapse();
		} else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
			event.preventDefault();
			lapsePlaying = false;
			goToRound(gameState.navigationCount + (event.key === 'ArrowRight' ? 1 : -1));
		}
	}

	const gameState = getGameState();
	const assetState = getAssetState();

	// Derived loading state
	const isLoading = $derived(gameState.isLoading || assetState.isLoading);
	const hasGameError = $derived(gameState.error !== null);
	const hasAssetError = $derived(assetState.error !== null);
	const hasAnyError = $derived(hasGameError || hasAssetError);

	// Build graph data from historical snapshots
	const graphData = $derived(getGraphData());

	// Show graphs section when we have historical data (more than 1 round)
	const showGraphs = $derived(graphData.length > 1);

	let initialSelectedPlayerColor = $state<string | null>(null);

	type TagPlayerRow = {
		playerColor: string;
		username: string | null;
		character: string;
	};

	const tagPlayers = $derived(() => {
		const finalSnapshots = gameState.allRoundSnapshots.get(gameState.maxNavigation) ?? [];
		const source = finalSnapshots.length > 0 ? finalSnapshots : gameState.playerSnapshots;

		const byColor = new Map<string, TagPlayerRow>();
		for (const s of source) {
			if (byColor.has(s.playerColor)) continue;
			byColor.set(s.playerColor, {
				playerColor: s.playerColor,
				username: s.ttsUsername ?? null,
				character: s.selectedCharacter
			});
		}

		return Array.from(byColor.values()).sort((a, b) => a.playerColor.localeCompare(b.playerColor));
	});

	type BarrierChangeRow = {
		playerColor: string;
		username: string | null;
		startBarrier: number | null;
		endBarrier: number | null;
		gained: number;
		lost: number;
		net: number | null;
	};

	function computeBarrierChanges(): BarrierChangeRow[] {
		const byPlayer = new Map<
			string,
			{
				startBarrier: number | null;
				endBarrier: number | null;
				lastBarrier: number | null;
				gained: number;
				lost: number;
			}
		>();

		for (const round of graphData) {
			for (const player of round.players) {
				const key = player.color;
				let entry = byPlayer.get(key);
				if (!entry) {
					entry = {
						startBarrier: player.barrier,
						endBarrier: player.barrier,
						lastBarrier: player.barrier,
						gained: 0,
						lost: 0
					};
					byPlayer.set(key, entry);
					continue;
				}

				const prev = entry.lastBarrier;
				const next = player.barrier;
				if (prev != null) {
					const diff = next - prev;
					if (diff > 0) entry.gained += diff;
					else if (diff < 0) entry.lost += -diff;
				}

				if (entry.startBarrier == null) entry.startBarrier = next;
				entry.endBarrier = next;
				entry.lastBarrier = next;
			}
		}

		const finalSnapshots = gameState.allRoundSnapshots.get(gameState.maxNavigation) ?? [];
		const usernamesByColor = new Map<string, string | null>();
		for (const snapshot of finalSnapshots) {
			usernamesByColor.set(snapshot.playerColor, snapshot.ttsUsername ?? null);
		}

		return Array.from(byPlayer.entries())
			.map(([playerColor, v]) => {
				const startBarrier = v.startBarrier;
				const endBarrier = v.endBarrier;
				return {
					playerColor,
					username: usernamesByColor.get(playerColor) ?? null,
					startBarrier,
					endBarrier,
					gained: v.gained,
					lost: v.lost,
					net: startBarrier != null && endBarrier != null ? endBarrier - startBarrier : null
				};
			})
			.sort((a, b) => a.playerColor.localeCompare(b.playerColor));
	}

	const barrierChanges = $derived(computeBarrierChanges());

	// Compute player stats for summary table (VP, VP/barrier, rune inventory, augments)
	const playerStats = $derived(() => {
		const finalSnapshots = gameState.allRoundSnapshots.get(gameState.maxNavigation) ?? [];
		const barrierData = computeBarrierChanges();
		const barrierGainedByColor = new Map(barrierData.map((b) => [b.playerColor, b.gained]));
		const totalRounds = gameState.maxNavigation;

		return finalSnapshots
			.map((snapshot) => {
				const barrierGained = barrierGainedByColor.get(snapshot.playerColor) ?? 0;
				const isSpiritAugmentSlot = (slot: (typeof snapshot.mats)[number]) => {
					if (!slot?.hasRune) return false;
					const type = typeof slot.type === 'string' ? slot.type.toLowerCase() : null;
					return type === 'class' || Boolean(slot.classId);
				};
				const runeInventory = (snapshot.mats ?? []).filter(
					(slot) => slot.hasRune && !isSpiritAugmentSlot(slot)
				).length;
				const spiritAugmentsDrawn = (snapshot.mats ?? []).filter(isSpiritAugmentSlot).length;
				const spiritAugmentsOnSpirits = (snapshot.spiritAugmentAttachments ?? []).filter(
					(attachment) => Boolean(attachment?.className) || Boolean(attachment?.classId)
				).length;
				const vpPerBarrier = barrierGained > 0 ? snapshot.victoryPoints / barrierGained : null;
				const vpPerRound = totalRounds > 0 ? snapshot.victoryPoints / totalRounds : null;

				return {
					playerColor: snapshot.playerColor,
					username: snapshot.ttsUsername ?? null,
					vp: snapshot.victoryPoints,
					barrierGained,
					vpPerBarrier,
					vpPerRound,
					runeInventory,
					spiritAugmentsDrawn,
					spiritAugmentsOnSpirits
				};
			})
			.sort((a, b) => b.vp - a.vp); // Sort by VP descending
	});

	const totalVictoryPoints = $derived(() => {
		const finalSnapshots = gameState.allRoundSnapshots.get(gameState.maxNavigation) ?? [];
		return finalSnapshots.reduce((sum, snapshot) => sum + snapshot.victoryPoints, 0);
	});

	const totalVictoryPointsPerRound = $derived(() => {
		if (gameState.maxNavigation <= 0) return null;
		return totalVictoryPoints() / gameState.maxNavigation;
	});

	const roundTimestamp = $derived(
		() => gameState.allRoundTimestamps.get(gameState.navigationCount) ?? null
	);

	const roundDeltaMs = $derived(() => {
		const currentRound = gameState.navigationCount;
		if (currentRound <= 1) return null;

		const currentTimestamp = gameState.allRoundTimestamps.get(currentRound);
		const previousTimestamp = gameState.allRoundTimestamps.get(currentRound - 1);
		if (!currentTimestamp || !previousTimestamp) return null;

		const currentMs = Date.parse(currentTimestamp);
		const previousMs = Date.parse(previousTimestamp);
		if (Number.isNaN(currentMs) || Number.isNaN(previousMs)) return null;

		const diff = currentMs - previousMs;
		return diff >= 0 ? diff : null;
	});

	let activeTab = $state<'round' | 'summary' | 'story' | 'rules'>('round');
	let copiedReplayValue = $state<string | null>(null);
	let copyReplayTimer: ReturnType<typeof setTimeout> | null = null;
	let copiedShareValue = $state<string | null>(null);
	let copyShareTimer: ReturnType<typeof setTimeout> | null = null;
	let shareBaseUrl = $state<string>('');
	let selectedPlayerColorForShare = $state<string | null>(null);

	function formatTimestamp(timestamp: string | null): string {
		if (!timestamp) return '—';
		const date = new Date(timestamp);
		if (Number.isNaN(date.getTime())) return String(timestamp);
		return date.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		});
	}

	function formatDuration(ms: number | null): string {
		if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';

		const totalSeconds = Math.floor(ms / 1000);
		const seconds = totalSeconds % 60;
		const totalMinutes = Math.floor(totalSeconds / 60);
		const minutes = totalMinutes % 60;
		const hours = Math.floor(totalMinutes / 60);

		if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
		if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
		return `${seconds}s`;
	}

	function formatScenarioLabel(
		value: unknown
	): string | null {
		if (!value) return null;
		if (typeof value === 'string') {
			const trimmed = value.trim();
			return trimmed.length > 0 ? trimmed : null;
		}
		if (typeof value === 'object') {
			const anyValue = value as { name?: unknown; requested?: unknown };
			const name = typeof anyValue.name === 'string' ? anyValue.name.trim() : '';
			if (name) return name;
			const requested = typeof anyValue.requested === 'string' ? anyValue.requested.trim() : '';
			return requested ? requested : null;
		}
		return null;
	}

	const replayRounds = $derived(() => {
		const rounds: Array<{
			round: number;
			shortCode: string;
			fullCode: string;
			timestamp: string | null;
		}> = [];
		const maxRound = gameState.maxNavigation;
		const timestamps = gameState.allRoundTimestamps;
		for (let round = maxRound; round >= 1; round -= 1) {
			rounds.push({
				round,
				shortCode: toShortReplayCode(round),
				fullCode: toFullReplayCode(data.gameId, round),
				timestamp: timestamps.get(round) ?? null
			});
		}
		return rounds;
	});

	const currentReplayShort = $derived(() => toShortReplayCode(gameState.navigationCount));
	const currentReplayFull = $derived(() =>
		toFullReplayCode(data.gameId, gameState.navigationCount)
	);

	async function copyReplay(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copiedReplayValue = value;
			if (copyReplayTimer) clearTimeout(copyReplayTimer);
			copyReplayTimer = setTimeout(() => {
				copiedReplayValue = null;
			}, 2000);
		} catch (e) {
			console.error('Failed to copy replay code:', e);
		}
	}

	async function copyShareLink(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copiedShareValue = value;
			if (copyShareTimer) clearTimeout(copyShareTimer);
			copyShareTimer = setTimeout(() => {
				copiedShareValue = null;
			}, 2000);
		} catch (e) {
			console.error('Failed to copy share link:', e);
		}
	}

	const currentShareLink = $derived(() => {
		const params = new URLSearchParams();
		if (gameState.navigationCount > 0) params.set('round', String(gameState.navigationCount));
		if (selectedPlayerColorForShare) params.set('player', selectedPlayerColorForShare);
		const query = params.toString();
		const path = explorerLinks.game(data.gameId, query ? `?${query}` : '');
		return shareBaseUrl ? `${shareBaseUrl}${path}` : path;
	});

	const navigationTiming = $derived(() => {
		const rounds = Array.from(gameState.allRoundTimestamps.entries())
			.map(([round, timestamp]) => ({ round, timestamp, ms: Date.parse(timestamp) }))
			.filter((entry) => !Number.isNaN(entry.ms))
			.sort((a, b) => a.round - b.round);

		const intervals: Array<{ fromRound: number; toRound: number; ms: number }> = [];
		for (let i = 1; i < rounds.length; i += 1) {
			const diff = rounds[i].ms - rounds[i - 1].ms;
			if (diff >= 0) {
				intervals.push({ fromRound: rounds[i - 1].round, toRound: rounds[i].round, ms: diff });
			}
		}

		const totalTimeMs =
			rounds.length >= 2 ? Math.max(0, rounds[rounds.length - 1].ms - rounds[0].ms) : null;

		const avgMs =
			intervals.length > 0
				? Math.round(intervals.reduce((sum, interval) => sum + interval.ms, 0) / intervals.length)
				: null;

		let longest: { fromRound: number; toRound: number; ms: number } | null = null;
		for (const interval of intervals) {
			if (!longest || interval.ms > longest.ms) longest = interval;
		}

		return {
			startedAt: rounds[0]?.timestamp ?? null,
			endedAt: rounds[rounds.length - 1]?.timestamp ?? null,
			totalRoundsWithTimestamps: rounds.length,
			totalIntervals: intervals.length,
			totalTimeMs,
			avgMs,
			longest
		};
	});

	const navigationDestinationDistribution = $derived(() => {
		const counts = new Map<string, number>();
		let total = 0;

		for (const snapshots of gameState.allRoundSnapshots.values()) {
			for (const snapshot of snapshots) {
				const destination = snapshot.navigationDestination?.trim() ?? '';
				if (!destination) continue;
				total += 1;
				counts.set(destination, (counts.get(destination) ?? 0) + 1);
			}
		}

		const sorted = Array.from(counts.entries())
			.map(([destination, count]) => ({ destination, count }))
			.sort((a, b) => b.count - a.count || a.destination.localeCompare(b.destination));

		const maxRows = 10;
		const top = sorted.slice(0, maxRows);
		const otherCount = sorted.slice(maxRows).reduce((sum, row) => sum + row.count, 0);
		const rows = otherCount > 0 ? [...top, { destination: 'Other', count: otherCount }] : top;

		const maxCount = rows.reduce((m, row) => Math.max(m, row.count), 0);

		return {
			total,
			unique: counts.size,
			rows: rows.map((row) => ({
				...row,
				percent: total > 0 ? (row.count / total) * 100 : 0,
				barPercent: maxCount > 0 ? (row.count / maxCount) * 100 : 0
			}))
		};
	});

	const monsterImageMap = $derived(() => {
		const map = new Map<string, string>();
		for (const [id, asset] of assetState.monsterAssets) {
			const path = asset.card_image_path;
			if (!path) continue;
			const url = path.startsWith('http') ? path : `${STORAGE_BASE_URL}/${path}`;
			map.set(id, url);
		}
		return map;
	});

	// Modal state for host notes editor and player feedback form
	let showHostNotesEditor = $state(false);
	let showPlayerFeedbackForm = $state(false);

	// Handle opening modals
	function handleEditNotes() {
		showHostNotesEditor = true;
	}

	function handleAddFeedback() {
		showPlayerFeedbackForm = true;
	}

	// Handle saving notes
	async function handleNotesSaved() {
		await refreshGameNotes();
	}

	// Handle feedback submitted
	async function handleFeedbackSubmitted() {
		await refreshPlayerFeedback();
	}

	// Determine error type for better messaging
	const errorInfo = $derived(() => {
		if (gameState.error) {
			if (gameState.error.includes('network') || gameState.error.includes('fetch')) {
				return {
					title: 'Connection Error',
					message:
						'Unable to connect to the game server. Please check your internet connection and try again.',
					variant: 'error' as const
				};
			}
			if (gameState.error.includes('not found') || gameState.error.includes('404')) {
				return {
					title: 'Game Not Found',
					message: `The game "${data.gameId}" could not be found. It may have been deleted or the ID is incorrect.`,
					variant: 'warning' as const
				};
			}
			return {
				title: 'Error Loading Game',
				message: gameState.error,
				variant: 'error' as const
			};
		}
		if (assetState.error) {
			return {
				title: 'Error Loading Assets',
				message: 'Failed to load game assets. The game may display without images.',
				variant: 'warning' as const
			};
		}
		return null;
	});

	// Handle round change from navigation or graph click
	function handleRoundChange(round: number) {
		goToRound(round);
	}

	function handleRoundSliderInput(event: Event) {
		const target = event.target as HTMLInputElement;
		const nextRound = Number.parseInt(target.value, 10);
		lapsePlaying = false;
		if (Number.isFinite(nextRound)) handleRoundChange(nextRound);
	}

	// Handle live toggle
	function handleToggleLive() {
		toggleLive();
	}

	// Handle toast dismiss
	function handleToastDismiss() {
		acknowledgeNewData();
	}

	// Handle "Go to latest" action from toast
	function handleGoToLatest() {
		toggleLive(); // This will turn on live mode and navigate to latest
	}

	function handleRetry() {
		loadGame(data.gameId);
		loadAssets();
	}

	onMount(() => {
		shareBaseUrl = window.location.origin;
		const params = new URLSearchParams(window.location.search);
		const roundParam = params.get('round');
		const parsedRound = roundParam ? Number.parseInt(roundParam, 10) : null;
		const initialRound =
			Number.isFinite(parsedRound) && (parsedRound ?? 0) > 0 ? parsedRound : null;
		const playerParam = params.get('player') ?? params.get('playerColor');
		const playerValue = playerParam ? playerParam.trim() : '';
		initialSelectedPlayerColor = playerValue ? playerValue : null;

		(async () => {
			await Promise.all([loadGame(data.gameId), loadAssets()]);
			if (initialRound != null) {
				await goToRound(initialRound);
			}
		})();
	});

	onDestroy(() => {
		if (copyReplayTimer) {
			clearTimeout(copyReplayTimer);
			copyReplayTimer = null;
		}
		if (copyShareTimer) {
			clearTimeout(copyShareTimer);
			copyShareTimer = null;
		}
		cleanup();
	});
</script>

<svelte:head>
	<title>Game {data.gameId.slice(0, 8)}... | Arc Spirits Spectate</title>
</svelte:head>

<svelte:window onkeydown={handleLapseKeys} />

{#snippet vpChart()}
	<ResourceGraph plain={explorer} type="victoryPoints" data={graphData} currentRound={gameState.navigationCount} onRoundClick={handleRoundChange} />
{/snippet}

<div class={explorer ? 'explorer-game flex flex-col bg-gray-950' : 'flex min-h-screen flex-col bg-gray-950'}>
	<!-- Main Content -->
	<main class="flex flex-1 flex-col">
		{#if isLoading && gameState.playerSnapshots.length === 0}
			<!-- Loading State -->
			<div class="flex flex-1 items-center justify-center">
				<div class="loading-container flex flex-col items-center gap-4">
					<div class="relative">
						<div
							class="h-16 w-16 animate-spin rounded-full border-4 border-gray-700 border-t-purple-500"
						></div>
						<div class="absolute inset-0 flex items-center justify-center">
							<div class="h-8 w-8 animate-pulse rounded-full bg-purple-500/20"></div>
						</div>
					</div>
					<div class="text-center">
						<p class="text-lg font-medium text-gray-300">Loading game data...</p>
						<p class="mt-1 text-sm text-gray-500">
							Connecting to {data.gameId.slice(0, 8)}...
						</p>
					</div>
				</div>
			</div>
		{:else if hasAnyError && gameState.playerSnapshots.length === 0}
			<!-- Error State -->
			{@const info = errorInfo()}
			<div class="flex flex-1 items-center justify-center p-8">
				{#if info}
					<ErrorDisplay
						title={info.title}
						message={info.message}
						variant={info.variant}
						onRetry={handleRetry}
					/>
				{/if}
			</div>
		{:else if gameState.playerSnapshots.length === 0}
			<!-- Empty State -->
			<div class="flex flex-1 items-center justify-center p-8">
				<div class="empty-state flex max-w-md flex-col items-center gap-6 text-center">
					<div class="relative">
						<div class="flex h-20 w-20 items-center justify-center rounded-full bg-gray-800">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="currentColor"
								class="h-10 w-10 text-gray-600"
							>
								<path
									fill-rule="evenodd"
									d="M8.25 6.75a3.75 3.75 0 117.5 0 3.75 3.75 0 01-7.5 0zM15.75 9.75a3 3 0 116 0 3 3 0 01-6 0zM2.25 9.75a3 3 0 116 0 3 3 0 01-6 0zM6.31 15.117A6.745 6.745 0 0112 12a6.745 6.745 0 016.709 7.498.75.75 0 01-.372.568A12.696 12.696 0 0112 21.75c-2.305 0-4.47-.612-6.337-1.684a.75.75 0 01-.372-.568 6.787 6.787 0 011.019-4.38z"
									clip-rule="evenodd"
								/>
								<path
									d="M5.082 14.254a8.287 8.287 0 00-1.308 5.135 9.687 9.687 0 01-1.764-.44l-.115-.04a.563.563 0 01-.373-.487l-.01-.121a3.75 3.75 0 013.57-4.047zM20.226 19.389a8.287 8.287 0 00-1.308-5.135 3.75 3.75 0 013.57 4.047l-.01.121a.563.563 0 01-.373.486l-.115.04c-.567.2-1.156.349-1.764.441z"
								/>
							</svg>
						</div>
						<div
							class="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full bg-gray-700"
						>
							<div class="h-2 w-2 animate-pulse rounded-full bg-yellow-500"></div>
						</div>
					</div>
					<div>
						<h2 class="text-xl font-semibold text-gray-200">Waiting for Players</h2>
						<p class="mt-2 text-gray-400">
							No game data available yet. Players will appear here once they join and sync from
							Tabletop Simulator.
						</p>
					</div>
					{#if gameState.isLive}
						<div
							class="flex items-center gap-2 rounded-lg bg-gray-800/50 px-4 py-2 text-sm text-green-400"
						>
							<span class="relative flex h-2 w-2">
								<span
									class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"
								></span>
								<span class="relative inline-flex h-2 w-2 rounded-full bg-green-500"></span>
							</span>
							Listening for updates...
						</div>
					{/if}
				</div>
			</div>
		{:else}
			<!-- Game Content -->
			<div class="flex flex-1 flex-col">
				<!-- Asset warning banner (non-blocking) -->
				{#if hasAssetError && !hasGameError}
					<div class="border-b border-yellow-800 bg-yellow-950/50 px-4 py-2">
						<div class="flex items-center justify-center gap-2 text-sm text-yellow-400">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								class="h-4 w-4"
							>
								<path
									fill-rule="evenodd"
									d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
									clip-rule="evenodd"
								/>
							</svg>
							<span
								>Some images may not display correctly. Asset loading error: {assetState.error}</span
							>
						</div>
					</div>
				{/if}

				<!-- Round / Summary Bar -->
				<div
					class="sticky top-[var(--app-topbar-height)] z-40 border-b border-gray-800 bg-gray-900/90 px-4 py-2 backdrop-blur-sm lg:px-6"
				>
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="flex items-center gap-2">
							<a
								href={explorerLinks.records('/')}
								class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-800 bg-gray-950/60 text-gray-200 transition-colors hover:bg-gray-950/80"
								aria-label="Back to Game Records"
								title="Back to Game Records"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 20 20"
									fill="currentColor"
									class="h-4 w-4"
									aria-hidden="true"
								>
									<path
										fill-rule="evenodd"
										d="M7.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L5.414 9H16a1 1 0 110 2H5.414l2.293 2.293a1 1 0 010 1.414z"
										clip-rule="evenodd"
									/>
								</svg>
							</a>
							<button
								type="button"
								onclick={() => (activeTab = 'round')}
								class={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
									activeTab === 'round'
										? 'bg-purple-600 text-white'
										: 'bg-gray-800 text-gray-300 hover:bg-gray-700'
								}`}
							>
								Round
							</button>
							<button
								type="button"
								onclick={() => (activeTab = 'summary')}
								class={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
									activeTab === 'summary'
										? 'bg-purple-600 text-white'
										: 'bg-gray-800 text-gray-300 hover:bg-gray-700'
								}`}
							>
								Summary
							</button>
							{#if explorer}
								<button
									type="button"
									onclick={() => (activeTab = 'story')}
									class={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
										activeTab === 'story' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
									}`}
								>
									Story
								</button>
							{/if}
							{#if explorer && rules}
								<button
									type="button"
									onclick={() => (activeTab = 'rules')}
									class={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
										activeTab === 'rules' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
									}`}
								>
									Rules in this game
								</button>
							{/if}
						</div>

						<div class="flex flex-wrap items-center justify-end gap-2">
{#if !explorer}
							<button
								type="button"
								onclick={handleToggleLive}
								class={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
									gameState.isLive
										? 'border-green-800 bg-green-950/70 text-green-200'
										: 'border-gray-800 bg-gray-950/60 text-gray-200 hover:bg-gray-950/80'
								}`}
								aria-pressed={gameState.isLive}
								title={gameState.isLive ? 'Disable live mode' : 'Enable live mode'}
							>
								<span class="relative flex h-2 w-2">
									{#if gameState.isLive}
										<span
											class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"
										></span>
										<span class="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
									{:else}
										<span class="relative inline-flex h-2 w-2 rounded-full bg-gray-500"></span>
									{/if}
								</span>
								Live
							</button>
							{:else}
							<button
								type="button"
								onclick={toggleLapse}
								class="inline-flex h-8 w-9 items-center justify-center rounded-md border border-gray-800 bg-gray-950/60 text-gray-200 transition-colors hover:bg-gray-950/80"
								aria-pressed={lapsePlaying}
								aria-label={lapsePlaying ? 'Pause' : 'Play the rounds'}
								title={lapsePlaying ? 'Pause (space)' : 'Play (space)'}
							>
								<svg viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4" aria-hidden="true">
									{#if lapsePlaying}
										<path d="M5 3h3.5v14H5zM11.5 3H15v14h-3.5z" />
									{:else}
										<path d="M5 3l11 7-11 7z" />
									{/if}
								</svg>
							</button>
							<button
								type="button"
								onclick={() => (lapseSpeed = LAPSE_SPEEDS[(LAPSE_SPEEDS.indexOf(lapseSpeed) + 1) % LAPSE_SPEEDS.length])}
								class="rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1.5 font-mono text-xs font-semibold text-gray-200 transition-colors hover:bg-gray-950/80"
								title="Speed"
							>
								{lapseSpeed}×
							</button>
							{/if}

							<div
								class="flex items-center gap-2 rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1.5"
							>
								<span class="font-mono text-[11px] font-semibold text-gray-200 tabular-nums">
									R{gameState.navigationCount}/{gameState.maxNavigation}
								</span>
								{#if gameState.maxNavigation > 1}
									<input
										type="range"
										min="1"
										max={gameState.maxNavigation}
										value={gameState.navigationCount}
										oninput={handleRoundSliderInput}
										class="round-slider w-32 sm:w-44 md:w-56 lg:w-64"
										aria-label="Round slider"
									/>
								{/if}
							</div>

{#if !explorer}
							<a
								href={`/game/${encodeURIComponent(data.gameId)}/export?auto=1`}
								target="_blank"
								rel="noopener noreferrer"
								class="rounded-md border border-purple-800 bg-purple-950/50 px-2.5 py-1.5 text-xs font-semibold text-purple-200 transition-colors hover:bg-purple-950/80"
								title="Export game history as PDF (one page per round)"
							>
								PDF
							</a>

							<button
								type="button"
								onclick={() => copyReplay(currentReplayFull())}
								class="rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1.5 text-xs font-semibold text-gray-200 transition-colors hover:bg-gray-950/80"
								title={`Copy replay code: ${currentReplayFull()}`}
							>
								{#if copiedReplayValue === currentReplayFull()}
									Copied
								{:else}
									Replay {currentReplayShort()}
								{/if}
							</button>

								<button
									type="button"
									onclick={() => copyShareLink(currentShareLink())}
									class="rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1.5 text-xs font-semibold text-gray-200 transition-colors hover:bg-gray-950/80"
									title={`Copy share link: ${currentShareLink()}`}
								>
									{#if copiedShareValue === currentShareLink()}
										Copied
									{:else}
										Share
									{/if}
								</button>

								{#if formatScenarioLabel(gameState.roundScenario)}
									<div
										class="flex items-center gap-1.5 rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1.5 text-[11px] text-gray-300"
										title="Scenario"
									>
										<span class="text-gray-500">Scenario</span>
										<span class="font-mono text-gray-200">{formatScenarioLabel(gameState.roundScenario)}</span>
									</div>
								{/if}

								<div
									class="flex items-center gap-1.5 rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1.5 text-[11px] text-gray-300"
								>
									<span class="text-gray-500">Timestamp</span>
								<span class="font-mono text-gray-200">{formatTimestamp(roundTimestamp())}</span>
							</div>

							<div
								class="flex items-center gap-1.5 rounded-md border border-gray-800 bg-gray-950/60 px-2.5 py-1.5 text-[11px] text-gray-300"
							>
								<span class="text-gray-500">Round time</span>
								<span class="font-mono text-gray-200">{formatDuration(roundDeltaMs())}</span>
							</div>
							{/if}
						</div>
					</div>
				</div>

				{#if activeTab === 'round'}
					<div class="flex flex-col xl:flex-row xl:items-start xl:gap-4">
						<div class="min-w-0 flex-1">
							<!-- Game Viewer (Players Grid) -->
							<GameViewer
								plain={explorer}
								handOf={explorer ? (color) => roundHands.get(`${gameState.navigationCount}:${color}`) ?? null : undefined}
								playerSnapshots={gameState.playerSnapshots}
								spiritAssets={assetState.spiritAssets}
								matAssets={assetState.matAssets}
								statusIcons={assetState.statusIcons}
								guardianAssets={assetState.guardianAssets}
								customDiceAssets={assetState.customDiceAssets}
								{initialSelectedPlayerColor}
								onPlayerSelect={(playerColor) => {
									selectedPlayerColorForShare = playerColor;
								}}
								sideExtra={explorer && showGraphs ? vpChart : undefined}
							/>

							{#if !explorer}
							<RoundBagsPanel
								round={gameState.navigationCount}
								bags={gameState.roundBags}
								monsterImageUrls={monsterImageMap()}
							/>
							{/if}
						</div>

						{#if data.isAdmin}
							<aside class="mt-4 shrink-0 xl:sticky xl:top-20 xl:mt-0 xl:w-80">
								<div class="overflow-hidden rounded-xl border border-gray-800 bg-gray-900/40">
									<div class="border-b border-gray-800 px-4 py-3">
										<div class="flex items-center justify-between gap-3">
											<h2 class="text-sm font-semibold text-gray-200">Admin · Tags</h2>
											<a
												href="/admin/stats/tags"
												class="text-xs font-semibold text-purple-300 hover:text-purple-200"
											>
												Tag stats
											</a>
										</div>
										<p class="mt-1 text-xs text-gray-500">
											Tag compositions while viewing boards. Stats count verified games only.
										</p>
									</div>

									<datalist id="composition-tag-options">
										{#each data.tagOptions ?? [] as option (option)}
											<option value={option}></option>
										{/each}
									</datalist>

									{#if data.taggingConfigError}
										<div
											class="border-b border-gray-800 bg-yellow-900/20 px-4 py-3 text-xs text-yellow-200"
										>
											{data.taggingConfigError}
										</div>
									{/if}

									{#if form?.error}
										<div
											class="border-b border-gray-800 bg-red-900/20 px-4 py-3 text-xs text-red-300"
										>
											{form.error}
										</div>
									{/if}

									<div class="space-y-4 p-4">
										{#if tagPlayers().length === 0}
											<div class="text-sm text-gray-400">Load the game to tag players.</div>
										{:else}
											{#each tagPlayers() as p (p.playerColor)}
												{@const tags = data.compositionTagsByColor?.[p.playerColor] ?? []}
												<div class="rounded-lg border border-gray-800 bg-gray-900/30 p-3">
													<div class="min-w-0">
														<div class="truncate font-semibold text-gray-100">
															{p.username ?? 'Unknown'}
														</div>
														<div class="mt-0.5 text-xs text-gray-500">
															{p.playerColor} • {p.character}
														</div>
													</div>

													<div class="mt-2 flex flex-wrap gap-2">
														{#if tags.length === 0}
															<span class="text-xs text-gray-500">No tags</span>
														{:else}
															{#each tags as tag (tag)}
																<form
																	method="POST"
																	action="?/removeTag"
																	use:enhance
																	class="inline-flex"
																>
																	<input type="hidden" name="playerColor" value={p.playerColor} />
																	<input type="hidden" name="tag" value={tag} />
																	<button
																		type="submit"
																		disabled={Boolean(data.taggingConfigError)}
																		class="inline-flex items-center gap-2 rounded-full border border-gray-700 bg-gray-900/50 px-2.5 py-1 text-xs font-semibold text-gray-200 hover:border-red-600/60 hover:text-red-200 disabled:opacity-50"
																		title="Remove tag"
																	>
																		<span class="max-w-[160px] truncate">{tag}</span>
																		<span class="text-gray-500">×</span>
																	</button>
																</form>
															{/each}
														{/if}
													</div>

													<form
														method="POST"
														action="?/addTag"
														use:enhance
														class="mt-3 flex items-center gap-2"
													>
														<input type="hidden" name="playerColor" value={p.playerColor} />
														<input
															name="tag"
															list="composition-tag-options"
															placeholder="e.g. astral mages"
															disabled={Boolean(data.taggingConfigError)}
															class="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:border-purple-500 focus:outline-none disabled:opacity-50"
														/>
														<button
															type="submit"
															disabled={Boolean(data.taggingConfigError)}
															class="rounded-md bg-purple-700 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-600 disabled:opacity-50"
														>
															Add
														</button>
													</form>
												</div>
											{/each}
										{/if}
									</div>

									<div class="border-t border-gray-800 px-4 py-3 text-[11px] text-gray-500">
										Tags are stored lowercased and trimmed.
									</div>
								</div>
							</aside>
						{/if}
					</div>
				{:else if activeTab === 'rules' && rules}
					<div class="rules-tab">{@render rules()}</div>
				{:else if activeTab === 'story'}
					<div class="story">
						{#if story}
							<h2>{story.headline}</h2>
							{#if story.luck}<div class="story-luck">{story.luck}</div>{/if}
							<p>{story.story}</p>
						{:else}
							<p class="story-luck">No story yet.</p>
						{/if}
					</div>
				{:else}
					{@const timing = navigationTiming()}
					{@const navDest = navigationDestinationDistribution()}
					{@const summaryVpPerRound = totalVictoryPointsPerRound()}
					{@const summaryTotalVp = totalVictoryPoints()}
					{@const winnerRow = playerStats()[0] ?? null}
					{@const runnerUps = playerStats().slice(1, 3)}
					<!-- ============ REDESIGNED SUMMARY ============ -->
					<div class="summary-shell">
						<div class="summary-main">
							<!-- Winner / Result -->
							{#if winnerRow}
								<div class="section-marker">
									<div class="sm-num">★</div>
									<div class="sm-label">Crowned Guardian</div>
								</div>
								<div class="winner-row">
									<div class="winner-name">{winnerRow.username ?? 'Unknown'} <span class="winner-color">· {winnerRow.playerColor}</span></div>
									<div class="winner-vp"><span class="vp-num">{winnerRow.vp}</span> VP</div>
								</div>
								<div class="winner-meta-row">
									{#if winnerRow.vpPerRound != null}<span><b>{winnerRow.vpPerRound.toFixed(2)}</b> VP / round</span>{/if}
									<span><b>{winnerRow.barrierGained}</b> barriers gained</span>
									{#if winnerRow.vpPerBarrier != null}<span><b>{winnerRow.vpPerBarrier.toFixed(2)}</b> VP / barrier</span>{/if}
									{#if runnerUps.length > 0}
										<span class="runners-inline">
											Runners-up:
											{#each runnerUps as r, i (r.playerColor)}
												{#if i > 0} · {/if}
												<b>{r.username ?? 'Unknown'}</b> ({r.vp} VP)
											{/each}
										</span>
									{/if}
								</div>
							{/if}

							<!-- Game Stats -->
							<div class="section-marker">
								<div class="sm-num">A</div>
								<div class="sm-label">Game Stats</div>
							</div>
							<div class="inline-stats summary-stats">
								<div>
									<span class="inline-stat-num">{gameState.maxNavigation}</span>
									<span class="inline-stat-label">Navigations</span>
								</div>
								<div>
									<span class="inline-stat-num">{summaryTotalVp}</span>
									<span class="inline-stat-label">Total VP</span>
								</div>
								<div>
									<span class="inline-stat-num">{summaryVpPerRound?.toFixed(2) ?? '—'}</span>
									<span class="inline-stat-label">VP / Round</span>
								</div>
								<div>
									<span class="inline-stat-num">{formatDuration(timing.totalTimeMs)}</span>
									<span class="inline-stat-label">Total Time</span>
								</div>
								<div>
									<span class="inline-stat-num">{formatDuration(timing.avgMs)}</span>
									<span class="inline-stat-label">Avg Nav</span>
								</div>
							</div>
							{#if timing.longest}
								<div class="summary-meta-line">Longest navigation: <b>{formatDuration(timing.longest.ms)}</b> between R{timing.longest.fromRound} → R{timing.longest.toRound}</div>
							{/if}

							<!-- Navigation Destinations -->
							<div class="section-marker">
								<div class="sm-num">B</div>
								<div class="sm-label">Cartography</div>
							</div>
							<h3 class="subhead">Navigation Destinations</h3>
							{#if navDest.total > 0}
								<p class="subhead-meta"><b>{navDest.total}</b> navigations across <b>{navDest.unique}</b> locations.</p>
								<div class="dest-list">
									{#each navDest.rows as row, i (row.destination)}
										<div class="dest-row">
											<div class="dest-rank">{String(i + 1).padStart(2, '0')}</div>
											<div class="dest-name" title={row.destination}>{row.destination}</div>
											<div class="dest-bar"><div class="dest-fill" style:width={`${row.barPercent}%`}></div></div>
											<div class="dest-count"><span class="mono">{row.count}</span> · {row.percent.toFixed(0)}%</div>
										</div>
									{/each}
								</div>
							{:else}
								<p class="subhead-meta">No navigation destination data recorded for this game.</p>
							{/if}

							<!-- Player Stats -->
							{#if playerStats().length > 0}
								<div class="section-marker">
									<div class="sm-num">C</div>
									<div class="sm-label">Final Standings</div>
								</div>
								<h3 class="subhead">Player Performance</h3>
								<div class="ps-table-wrap">
									<div class="ps-table">
										<div class="ps-row ps-head">
											<div class="cell">Player</div>
											<div class="cell num">VP</div>
											<div class="cell num">VP/Rd</div>
											<div class="cell num">Barriers</div>
											<div class="cell num">VP/Brr</div>
											<div class="cell num">Runes</div>
											<div class="cell num">Augm. Drawn</div>
											<div class="cell num">Augm. on Spirits</div>
										</div>
										{#each playerStats() as row, i (row.playerColor)}
											<div class="ps-row" class:winner={i === 0}>
												<div class="cell player-cell">
													<div class="rank-num-cell">{i === 0 ? '★' : i + 1}</div>
													<div>
														<div class="p-name">{row.username ?? 'Unknown'}</div>
														<div class="p-color">{row.playerColor}</div>
													</div>
												</div>
												<div class="cell num"><span class="vp-big">{row.vp}</span></div>
												<div class="cell num">{row.vpPerRound != null ? row.vpPerRound.toFixed(2) : '—'}</div>
												<div class="cell num">{row.barrierGained}</div>
												<div class="cell num">{row.vpPerBarrier != null ? row.vpPerBarrier.toFixed(2) : '—'}</div>
												<div class="cell num">{row.runeInventory}</div>
												<div class="cell num">{row.spiritAugmentsDrawn}</div>
												<div class="cell num">{row.spiritAugmentsOnSpirits}</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Replay Codes -->
							{#if gameState.maxNavigation > 0}
								<details class="replay-details">
									<summary class="replay-summary">
										<div>
											<div class="section-marker compact">
												<div class="sm-num">D</div>
												<div class="sm-label">Time-Stones</div>
											</div>
											<h3 class="subhead">Replay Codes <span class="latest-inline">· Latest <code>{toShortReplayCode(gameState.maxNavigation)}</code></span></h3>
											<p class="subhead-meta">Use in TTS <b>Replay Load</b> to restore a navigation snapshot. Click to expand all rounds.</p>
										</div>
										<svg class="chevron" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
									</summary>
									<div class="replay-list">
										{#each replayRounds() as entry (entry.round)}
											<div class="replay-row">
												<div class="rr-round">Round {entry.round}</div>
												<button
													type="button"
													onclick={() => copyReplay(entry.shortCode)}
													class="rr-code"
													title="Copy 4-digit code"
												>{entry.shortCode}</button>
												<div class="rr-full" title={entry.fullCode}>{entry.fullCode}</div>
												{#if entry.timestamp}<div class="rr-time">{formatTimestamp(entry.timestamp)}</div>{/if}
												<button
													type="button"
													onclick={() => copyReplay(entry.fullCode)}
													class="text-btn-sm"
													title="Copy full replay code"
												>{copiedReplayValue === entry.fullCode ? 'Copied' : 'Copy'}</button>
											</div>
										{/each}
									</div>
								</details>
							{/if}
						</div>

						<!-- Graphs Sidebar -->
						{#if showGraphs}
							<aside class="summary-sidebar">
								<div class="section-marker">
									<div class="sm-num">E</div>
									<div class="sm-label">Resource Currents</div>
								</div>
								<h3 class="subhead">Game Progress</h3>
								<div class="graph-stack">
									<ResourceGraph plain={explorer}
										type="brokenBarrier"
										data={graphData}
										currentRound={gameState.navigationCount}
										onRoundClick={handleRoundChange}
									/>
									<ResourceGraph plain={explorer}
										type="barrierGained"
										data={graphData}
										currentRound={gameState.navigationCount}
										onRoundClick={handleRoundChange}
									/>
									<ResourceGraph plain={explorer}
										type="victoryPoints"
										data={graphData}
										currentRound={gameState.navigationCount}
										onRoundClick={handleRoundChange}
									/>
								</div>
							</aside>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</main>

	<!-- Toast notification for new data when not in live mode -->
	<Toast
		show={gameState.hasNewData && !gameState.isLive}
		message="New game data available"
		type="info"
		onDismiss={handleToastDismiss}
		onAction={handleGoToLatest}
		actionLabel="Go Live"
		autoDismiss={true}
		dismissAfter={8000}
	/>

	<!-- Host Notes Editor Modal -->
	{#if showHostNotesEditor}
		<HostNotesEditor
			gameId={data.gameId}
			existingNotes={gameState.gameNotes}
			onClose={() => (showHostNotesEditor = false)}
			onSave={handleNotesSaved}
		/>
	{/if}

	<!-- Player Feedback Form Modal -->
	{#if showPlayerFeedbackForm}
		<PlayerFeedbackForm
			gameId={data.gameId}
			onClose={() => (showPlayerFeedbackForm = false)}
			onSubmit={handleFeedbackSubmitted}
		/>
	{/if}
</div>

<style>
	/* Local explorer: the viewer fills the frame; a longer tab scrolls inside it. */
	.story { max-width: 70ch; padding: 24px 20px; }
	.story p { margin: 10px 0 0; white-space: pre-wrap; }
	.story-luck { color: var(--dim, #9a9eab); }
	.rules-tab { padding: 20px; max-width: 1400px; }
	.explorer-game {
		--viewer-offset: 53px;
		height: 100%;
		overflow-y: auto;
	}

	.loading-container {
		animation: fade-in 0.3s ease-out;
	}

	.empty-state {
		animation: fade-in 0.4s ease-out;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	summary {
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.chevron {
		transition: transform 150ms ease;
	}

	details[open] .chevron {
		transform: rotate(180deg);
	}

	.round-slider {
		height: 0.25rem;
		border-radius: 9999px;
		background-color: rgb(55 65 81); /* gray-700 */
		appearance: none;
		cursor: pointer;
		accent-color: rgb(168 85 247); /* purple-500 */
	}

	.round-slider::-webkit-slider-thumb {
		appearance: none;
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 9999px;
		background-color: rgb(168 85 247); /* purple-500 */
		border: 2px solid rgb(17 24 39); /* gray-900 */
	}

	.round-slider::-moz-range-thumb {
		width: 0.85rem;
		height: 0.85rem;
		border-radius: 9999px;
		background-color: rgb(168 85 247); /* purple-500 */
		border: 2px solid rgb(17 24 39); /* gray-900 */
	}

	/* ============ FLAT SUMMARY ============ */
	.summary-shell { display: flex; flex-direction: column; gap: 32px; padding: 36px 24px; }
	@media (min-width: 1024px) {
		.summary-shell { flex-direction: row; gap: 48px; padding: 44px 32px; }
	}
	.summary-main { flex: 1; min-width: 0; }
	.summary-sidebar { width: 100%; }
	@media (min-width: 1024px) {
		.summary-sidebar { width: 380px; flex-shrink: 0; position: sticky; top: calc(var(--app-topbar-height) + 60px); align-self: flex-start; }
	}

	.winner-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 24px;
		flex-wrap: wrap;
		margin-bottom: 6px;
	}
	.winner-name {
		font-family: var(--font-display);
		font-weight: 900;
		font-size: clamp(1.6rem, 3.5vw, 2.2rem);
		color: var(--color-bone);
		letter-spacing: -0.01em;
	}
	.winner-color { color: var(--color-fog); font-weight: 500; font-size: 0.75em; }
	.winner-vp { font-family: var(--font-display); font-size: 0.75rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--color-fog); }
	.vp-num { font-family: var(--font-display); font-weight: 900; font-size: 2.2rem; color: var(--brand-amber-soft); margin-right: 8px; vertical-align: baseline; font-variant-numeric: tabular-nums; }
	.winner-meta-row {
		display: flex; flex-wrap: wrap; gap: 22px;
		font-size: 0.82rem; color: var(--color-parchment);
		padding-bottom: 32px;
		border-bottom: 1px solid var(--color-mist);
		margin-bottom: 32px;
	}
	.winner-meta-row b { font-family: var(--font-display); font-weight: 700; color: var(--brand-amber-soft); margin-right: 4px; font-variant-numeric: tabular-nums; }
	.runners-inline { color: var(--color-fog); }
	.runners-inline b { color: var(--color-bone); }

	.summary-stats {
		padding: 16px 0 12px;
		margin-bottom: 8px;
	}
	.summary-meta-line { font-size: 0.78rem; color: var(--color-fog); margin-bottom: 36px; padding-bottom: 18px; }
	.summary-meta-line b { color: var(--color-bone); font-family: var(--font-display); font-weight: 700; font-variant-numeric: tabular-nums; }

	.dest-list { margin-bottom: 36px; border-top: 1px solid var(--color-mist); }
	.dest-row {
		display: grid;
		grid-template-columns: 28px minmax(140px, 220px) 1fr 100px;
		align-items: center;
		gap: 14px;
		padding: 10px 8px;
		border-bottom: 1px solid var(--color-mist);
		transition: background 180ms ease;
	}
	.dest-row:hover { background: rgba(255, 43, 199, 0.04); }
	.dest-rank { font-family: var(--font-display); font-weight: 800; font-size: 0.75rem; color: var(--color-fog); font-variant-numeric: tabular-nums; }
	.dest-name { font-size: 0.85rem; color: var(--color-bone); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.dest-bar { position: relative; height: 4px; background: var(--color-mist); }
	.dest-fill { position: absolute; inset: 0; background: var(--brand-magenta); }
	.dest-count { text-align: right; font-size: 0.78rem; color: var(--color-parchment); font-variant-numeric: tabular-nums; }
	.dest-count .mono { font-family: var(--font-display); font-weight: 700; color: var(--color-bone); margin-right: 2px; }

	.ps-table-wrap { overflow-x: auto; margin-bottom: 36px; }
	.ps-table { display: flex; flex-direction: column; min-width: 720px; border-top: 1px solid var(--color-mist); }
	.ps-row {
		display: grid;
		grid-template-columns: minmax(170px, 1.6fr) 70px 80px 100px 90px 80px 110px 130px;
		align-items: center;
		gap: 12px;
		padding: 12px 8px;
		border-bottom: 1px solid var(--color-mist);
		transition: background 180ms ease;
	}
	.ps-row:not(.ps-head):hover { background: rgba(255, 43, 199, 0.04); }
	.ps-row.ps-head {
		font-family: var(--font-display);
		font-size: 0.6rem;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--color-fog);
		font-weight: 700;
	}
	.ps-row.winner { background: rgba(255, 186, 61, 0.04); border-left: 3px solid var(--brand-amber-soft); padding-left: 5px; }
	.cell { font-size: 0.88rem; color: var(--color-bone); font-variant-numeric: tabular-nums; }
	.cell.num { text-align: right; font-weight: 600; }
	.player-cell { display: flex; gap: 12px; align-items: center; text-align: left !important; }
	.rank-num-cell {
		display: grid; place-items: center;
		width: 28px; height: 28px;
		font-family: var(--font-display);
		font-weight: 800;
		font-size: 0.95rem;
		color: var(--color-fog);
		font-variant-numeric: tabular-nums;
	}
	.ps-row.winner .rank-num-cell { color: var(--brand-amber-soft); }
	.p-name { font-family: var(--font-display); font-weight: 700; font-size: 0.95rem; color: var(--color-bone); }
	.p-color { font-size: 0.65rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--color-fog); margin-top: 2px; }
	.vp-big { font-family: var(--font-display); font-weight: 800; color: var(--brand-amber-soft); font-size: 1.05rem; }

	/* REPLAY — flat list */
	.replay-details summary { cursor: pointer; list-style: none; }
	.replay-details summary::-webkit-details-marker { display: none; }
	.replay-summary { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 0; }
	.section-marker.compact { padding-bottom: 8px; margin-bottom: 12px; }
	.latest-inline { font-family: var(--font-mono); font-weight: 500; color: var(--color-fog); font-size: 0.7em; letter-spacing: 0.05em; text-transform: none; margin-left: 8px; }
	.latest-inline code { color: var(--brand-magenta-soft); font-weight: 700; }
	.replay-summary .chevron { width: 18px; height: 18px; color: var(--color-fog); transition: transform 180ms ease; }
	.replay-details[open] .replay-summary .chevron { transform: rotate(180deg); color: var(--brand-magenta-soft); }
	.replay-list { margin-top: 16px; border-top: 1px solid var(--color-mist); }
	.replay-row {
		display: grid;
		grid-template-columns: 80px 110px 1fr 140px 60px;
		align-items: center;
		gap: 14px;
		padding: 10px 8px;
		border-bottom: 1px solid var(--color-mist);
	}
	.replay-row:hover { background: rgba(255, 43, 199, 0.04); }
	.rr-round { font-family: var(--font-display); font-weight: 700; font-size: 0.65rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--color-fog); }
	.rr-code {
		background: transparent; border: 0; padding: 0; cursor: pointer; text-align: left;
		font-family: var(--font-mono);
		font-weight: 700;
		font-size: 1.05rem;
		color: var(--color-bone);
		letter-spacing: 0.05em;
		transition: color 180ms ease;
	}
	.rr-code:hover { color: var(--brand-magenta-soft); }
	.rr-full { font-family: var(--font-mono); font-size: 0.72rem; color: var(--color-fog); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rr-time { font-family: var(--font-mono); font-size: 0.7rem; color: var(--color-whisper); text-align: right; }
	.text-btn-sm {
		background: transparent;
		border: 0;
		padding: 0;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.6rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--brand-magenta-soft);
		cursor: pointer;
		transition: color 180ms ease;
		justify-self: end;
	}
	.text-btn-sm:hover { color: var(--brand-magenta); }

	.graph-stack { display: flex; flex-direction: column; gap: 22px; margin-top: 4px; }

	@media (max-width: 720px) {
		.replay-row { grid-template-columns: 60px 90px 1fr 50px; }
		.replay-row .rr-time { display: none; }
		.dest-row { grid-template-columns: 24px 1fr 80px; }
		.dest-row .dest-bar { display: none; }
	}
</style>
