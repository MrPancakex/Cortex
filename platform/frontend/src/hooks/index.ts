import { useApi } from './useApi';
import { useSimulation } from './useSimulation';

// Decide simulation vs live once at module load so React's Rules of Hooks
// aren't violated by a conditional hook call inside useDashboard.
const SIM_ALLOWED = import.meta.env.VITE_ALLOW_SIM === 'true';
const SIM_QUERY = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('sim') === '1';
const IS_SIMULATION = SIM_ALLOWED && SIM_QUERY;

export const useDashboard = IS_SIMULATION ? useSimulation : useApi;
