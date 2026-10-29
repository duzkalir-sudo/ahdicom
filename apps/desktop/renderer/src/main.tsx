import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initI18n } from './i18n';
import { useStore } from './state/store';
import { installTestHooks } from './testHooks';
import './styles/app.css';

async function bootstrap(): Promise<void> {
  const [settings, info] = await Promise.all([window.api.getSettings(), window.api.appInfo()]);
  await initI18n(settings.language);
  useStore.getState().setSettings(settings);
  useStore.getState().setAppInfo(info);
  if (info.e2e) installTestHooks();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
