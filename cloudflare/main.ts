import '../app/main';
import { installDiagnostics } from './diagnostics';
import { publicTransport } from './publictransport';

// Keep the test deployment independent of the production PHP host.
(window as any).app.myserver = window.location.origin;
installDiagnostics((window as any).app);
(window as any).app.fetchOverride = publicTransport(window.location.origin, window.fetch.bind(window));
