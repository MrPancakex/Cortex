import { useApi } from './useApi';
import { useSimulation } from './useSimulation';
import { useState, useEffect } from 'react';

export function useDashboard() {
  const simAllowed = import.meta.env.VITE_ALLOW_SIM === 'true';
  const useSim = simAllowed && window.location.search.includes('sim=1');
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (useSim) return useSimulation();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useApi();
}
