import React from 'react';
import VioletTactical from './VioletTactical';
import { useDashboard } from './hooks';

export default function App() {
  const dashboardData = useDashboard();
  return <VioletTactical {...dashboardData} />;
}
