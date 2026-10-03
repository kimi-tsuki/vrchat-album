import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyAppearance, readPreferences } from './preferences';
import { App } from './App';
import { Guide } from './Guide';
import './styles.css';

applyAppearance(readPreferences());
const guide = ['/guide', '/web/guide.html'].includes(window.location.pathname);
createRoot(document.getElementById('root')!).render(<StrictMode>{guide ? <Guide /> : <App />}</StrictMode>);
