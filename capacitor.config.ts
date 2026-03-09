import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'fans.forsure.app',
  appName: 'Forsure',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
