// Initialize Vercel Speed Insights
import { injectSpeedInsights } from './vendor/speed-insights.mjs';

// Inject Speed Insights tracking
// This will automatically track web vitals and performance metrics
injectSpeedInsights({
  debug: false // Set to true in development if you want to see debug logs
});
