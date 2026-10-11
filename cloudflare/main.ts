import '../app/main';
import { installDiagnostics } from './diagnostics';

// Keep the test deployment independent of the production PHP host.
(window as any).app.myserver = window.location.origin;
installDiagnostics((window as any).app);
