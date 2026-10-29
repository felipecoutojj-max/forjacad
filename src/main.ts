import './styles.css';
import { App } from './ui/app';
import { registerSW } from 'virtual:pwa-register';

const root = document.getElementById('app')!;
const app = new App(root);
(window as unknown as { forja: App }).forja = app;

registerSW({ immediate: true, onOfflineReady() { app.toast('Pronto para usar off-line.'); } });
