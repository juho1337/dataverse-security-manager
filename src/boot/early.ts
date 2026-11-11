// Imported FIRST by main.tsx so the handlers exist before any other module of the bundle is evaluated (an error while evaluating a later module
// is then caught and shown instead of leaving a blank window).
import { installDiagnostics } from './diagnostics';

installDiagnostics();
