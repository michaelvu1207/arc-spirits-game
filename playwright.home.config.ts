import { defineConfig } from '@playwright/test';
import base from './playwright.navigation.config';
export default defineConfig({ ...base, testMatch: 'home-restoration.spec.ts', timeout: 90000 });
