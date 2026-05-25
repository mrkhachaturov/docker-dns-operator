import { Controller, Get } from '@nestjs/common';

// Liveness — the fact that this responds at all proves the HTTP server is up
// and the Node event loop is alive. Same shape external-dns uses
// (controller/execute.go::serveMetrics). Per-provider health is each
// sidecar's own /healthz, not the operator's concern.
@Controller('healthz')
export class HealthController {
  // eslint-disable-next-line class-methods-use-this
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
