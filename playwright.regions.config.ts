import { defineConfig } from '@playwright/test';
import base from './playwright.navigation.config';
export default defineConfig({
	...base,
	testMatch: 'region-power-trades.spec.ts',
	timeout: 120_000
});
