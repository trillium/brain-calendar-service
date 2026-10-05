// A local fixture CalDAV server. No network, no credentials, no clock.
//
// The plan requires contract tests against recorded fixtures with a local
// fixture server, precisely so the transport is exercised for real - a mocked
// HTTP client proves nothing about status codes and bodies, and the two cases
// that matter here (the invalid sync-token fallback, and a 404 on a deleted
// event) ARE status codes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FixtureEvent {
  href: string;
  etag: string;
  status: number;
  calendarData: string;
}

export interface FixtureOptions {
  events: readonly FixtureEvent[];
  /** Token the server will accept; anything else gets the 403 the spec requires. */
  validSyncToken: string;
}

export interface FixtureServer {
  readonly url: string;
  readonly requests: { method: string; body: string }[];
  advance(events: readonly FixtureEvent[], newToken: string): void;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });

export const startFixtureServer = async (options: FixtureOptions): Promise<FixtureServer> => {
  let events = [...options.events];
  let token = options.validSyncToken;
  const requests: { method: string; body: string }[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({ method: req.method ?? "", body });

      if (req.method === "REPORT") {
        const requested = /<D:sync-token>([^<]*)<\/D:sync-token>/.exec(body)?.[1] ?? "";
        if (requested !== "" && requested !== token) {
          // The spec's answer to a stale token: 403 with a precondition body.
          res.writeHead(403, { "content-type": "application/xml" });
          res.end(`<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>`);
          return;
        }
        // RFC 6578: a REPORT with a token returns what CHANGED since that token.
        // An empty token means an initial sync, which returns everything.
        const changed = requested === "" ? events : events.filter((e) => e.etag !== requested);
        res.writeHead(207, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">` +
            changed
              .map(
                (e) =>
                  `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop>` +
                  `<D:getetag>${e.etag}</D:getetag><D:status>HTTP/1.1 ${e.status} ${e.status === 200 ? "OK" : "Not Found"}</D:status>` +
                  `</D:prop></D:propstat></D:response>`,
              )
              .join("") +
            `<D:sync-token>${token}</D:sync-token></D:multistatus>`,
        );
        return;
      }

      if (req.method === "PROPFIND") {
        res.writeHead(207, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">` +
            events
              .map(
                (e) =>
                  `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop>` +
                  `<D:getetag>${e.etag}</D:getetag></D:prop></D:propstat></D:response>`,
              )
              .join("") +
            `</D:multistatus>`,
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fixture");
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    advance(next, newToken) {
      events = [...next];
      token = newToken;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
