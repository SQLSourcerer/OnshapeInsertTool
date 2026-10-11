import '../app/main';

// Keep the test deployment independent of the production PHP host.
(window as any).app.myserver = window.location.origin;
