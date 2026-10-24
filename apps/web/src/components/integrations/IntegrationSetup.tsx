import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Connection,
  IntegrationCatalogResult,
  McpServer,
  MessagingStatus,
} from "@rakazo/contracts";
import { connectCatalogItem } from "@rakazo/core";
import { Button, Disclosure, Input } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { newClientId } from "../../lib/client-id";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const officeApps = ["Gmail", "Fakturownia", "KeyCRM", "wFirma", "Telegram"] as const;
type OfficeApp = (typeof officeApps)[number];
type BusinessProvider = "fakturownia" | "keycrm" | "wfirma";
const businessProviders: Partial<Record<OfficeApp, BusinessProvider>> = {
  Fakturownia: "fakturownia",
  KeyCRM: "keycrm",
  wFirma: "wfirma",
};
const businessEndpoint = "http://127.0.0.1:45181/mcp";

export function businessApprovalNames(provider: BusinessProvider, slug: string) {
  const keycrm = [
    "create_product",
    "update_product",
    "publish_product",
    "unpublish_product",
    "archive_product",
    "update_product_photo",
    "bulk_update_products",
    "create_offer",
    "update_offer",
    "create_category",
    "adjust_stock",
    "create_order",
    "update_order",
    "update_order_status",
    "add_order_payment",
    "add_order_tag",
    "remove_order_tag",
    "attach_external_transaction",
    "create_customer",
    "update_customer",
    "import_customers",
    "create_pipeline_card",
    "update_pipeline_card",
    "upload_file",
  ];
  const names =
    provider === "keycrm"
      ? keycrm.map((name) => `keycrm_${name}`)
      : provider === "fakturownia"
        ? ["fakturownia_create_invoice", "fakturownia_send_invoice_email"]
        : [];
  return names.map((name) => `mcp__${slug}__${name}`);
}

async function requireOfficeApproval(names: string[]) {
  await Promise.all(
    names.map((matchValue) =>
      rpc.approvalRules.set({ effect: "require_approval", matchKind: "tool", matchValue }),
    ),
  );
  if (!names.length) return;
  const rules = await rpc.approvalRules.list();
  if (
    !names.every((name) =>
      rules.some(
        (rule) =>
          rule.effect === "require_approval" &&
          rule.matchKind === "tool" &&
          rule.matchValue === name,
      ),
    )
  )
    throw new Error("Approval policy unavailable");
}

/** Browser-safe contract: only native MCP owns persistence/encryption. */
export function businessRegistration(input: {
  provider: BusinessProvider;
  accountId: string;
  name: string;
  userId: string;
  spaceId: string;
  token: string;
  accessKey: string;
  secretKey: string;
  appKey: string;
  host: string;
}) {
  const binding = { userId: input.userId, spaceId: input.spaceId, accountId: input.accountId };
  if (
    ![binding.userId, binding.spaceId, binding.accountId].every((value) =>
      /^[a-zA-Z0-9_-]{1,100}$/.test(value),
    )
  )
    throw new Error("Invalid account");
  let host: string | undefined;
  if (input.provider === "fakturownia") {
    const label = input.host
      .trim()
      .toLowerCase()
      .replace(/\.fakturownia\.pl$/, "");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      throw new Error("Invalid account domain");
    host = `https://${label}.fakturownia.pl`;
  }
  const credentials =
    input.provider === "wfirma"
      ? { accessKey: input.accessKey, secretKey: input.secretKey, appKey: input.appKey }
      : { token: input.token };
  if (!Object.values(credentials).every((value) => value.trim() && value.length <= 1024))
    throw new Error("Credentials required");
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      provider: input.provider,
      binding: { ...binding, ...(host ? { host } : {}) },
      credentials,
    }),
  );
  const secret = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return {
    slug: input.accountId,
    name: input.name.trim() || input.provider,
    description: host ?? "Office account",
    transport: "streamable_http" as const,
    endpoint: businessEndpoint,
    enabled: true,
    secret,
  };
}

function OfficeConnections({ botId }: { botId?: string }) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<OfficeApp>("Gmail");
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [messaging, setMessaging] = useState<MessagingStatus | null>(null);
  const [actor, setActor] = useState<{ userId: string; spaceId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [appKey, setAppKey] = useState("");
  const [editing, setEditing] = useState<McpServer | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const provider = businessProviders[selected];
  const clearCredentials = () => {
    setToken("");
    setAccessKey("");
    setSecretKey("");
    setAppKey("");
  };
  async function refresh() {
    const [me, rows, accounts, status] = await Promise.all([
      rpc.me(),
      rpc.mcp.servers.list(),
      rpc.connections.list(),
      rpc.messaging.status(),
    ]);
    setActor({ userId: me.userId, spaceId: me.spaceId });
    setServers(rows);
    setConnections(accounts);
    setMessaging(status);
  }
  useEffect(() => {
    void refresh().catch(() => setNotice(t`Could not load accounts`));
    return () => attempt.current?.abort();
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      const me = await rpc.me();
      if (!actor || me.userId !== actor.userId || me.spaceId !== actor.spaceId)
        throw new Error("Account changed; reopen Connect apps");
      await action();
      await refresh();
    } catch {
      setNotice(t`Could not connect. Check the account and office connector setup.`);
    } finally {
      clearCredentials();
      setBusy(false);
    }
  }
  async function connectBusiness() {
    if (!provider || !actor) return;
    await run(async () => {
      const current = await rpc.mcp.servers.list();
      if (
        editing &&
        !current.some(
          (row) =>
            row.id === editing.id && row.slug === editing.slug && row.endpoint === businessEndpoint,
        )
      )
        throw new Error("Account unavailable");
      const accountId = editing?.slug ?? `agente-pl-${provider}-${newClientId()}`;
      const config = businessRegistration({
        provider,
        accountId,
        name,
        host,
        token,
        accessKey,
        secretKey,
        appKey,
        ...actor,
      });
      await requireOfficeApproval(businessApprovalNames(provider, accountId));
      if (editing && provider === "fakturownia" && config.description !== editing.description)
        throw new Error("Use a new account for another domain");
      const server = editing
        ? await rpc.mcp.servers.update({ id: editing.id, config })
        : await rpc.mcp.servers.create(config);
      // Catalog reachability is not proof that a provider accepted its key.
      const tested = await rpc.mcp.servers.test({ id: server.id });
      if (tested.health.status === "ok" && botId)
        await rpc.mcp.assignments.approve({ botId, serverId: server.id });
      setEditing(null);
      setName("");
      setHost("");
      setNotice(t`Account added. Verify access with a permitted read.`);
    });
  }
  async function connectGmail() {
    await run(async () => {
      const catalog = await rpc.connections.catalog({ connectorId: "composio", query: "gmail" });
      const gmail = catalog.find(
        (item) => item.connectorId === "composio" && item.slug.toLowerCase() === "gmail",
      );
      if (!gmail) throw new Error("Set up Composio first");
      const controller = new AbortController();
      attempt.current = controller;
      const result = await connectCatalogItem(gmail, connections, {
        begin: (input) => rpc.connections.begin(input),
        complete: (input) => rpc.connections.complete(input),
        openUrl: (url) => window.open(url, "rakazo-plugin-connect", "noopener,noreferrer"),
        signal: controller.signal,
      });
      if (result.status === "connected") {
        const tools = await rpc.connections.tools({
          connectorId: "composio",
          provider: gmail.slug,
        });
        if (!tools.length) throw new Error("Gmail tools unavailable");
        await requireOfficeApproval(tools.map((tool) => tool.name));
      }
      if (result.status === "connected" && botId)
        await rpc.onboarding.appConnected({ botId, provider: gmail.slug, connectorId: "composio" });
      setNotice(result.status === "connected" ? t`Connected` : t`Connection pending`);
    });
  }
  async function connectFakturowniaReads() {
    await run(async () => {
      const label = host
        .trim()
        .toLowerCase()
        .replace(/\.fakturownia\.pl$/, "");
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
        throw new Error("Invalid account domain");
      const endpoint = `https://${label}.fakturownia.pl/mcp`;
      const existing = (await rpc.mcp.servers.list()).find((row) => row.endpoint === endpoint);
      const server =
        existing ??
        (await rpc.mcp.servers.create({
          slug: `agente-pl-fakturownia-oauth-${newClientId().slice(0, 8)}`,
          name: name.trim() || "Fakturownia",
          transport: "streamable_http",
          endpoint,
        }));
      const result = await connectMcpOauth(server.id);
      if (result === "cancelled") return;
      const checked = await rpc.mcp.servers.test({ id: server.id });
      if (checked.health.status !== "ok") throw new Error("Discovery unavailable");
      if (botId) await rpc.mcp.assignments.approve({ botId, serverId: server.id });
      setNotice(t`Connected`);
    });
  }
  const businessAccounts = provider
    ? servers.filter(
        (row) =>
          row.slug.startsWith(`agente-pl-${provider}-`) &&
          (row.endpoint === businessEndpoint ||
            (provider === "fakturownia" &&
              /^https:\/\/[a-z0-9-]+\.fakturownia\.pl\/mcp$/.test(row.endpoint ?? ""))),
      )
    : [];
  const gmailAccounts = connections.filter(
    (row) =>
      row.connectorId === "composio" &&
      row.provider.toLowerCase() === "gmail" &&
      row.status !== "revoked",
  );
  const telegramAccounts =
    messaging?.identities.filter(
      (row) => row.provider === "telegram" || row.provider.startsWith("telegram-"),
    ) ?? [];
  return (
    <section className="space-y-4" aria-label={t`Office apps`}>
      <div className="flex flex-wrap gap-2">
        {officeApps.map((app) => (
          <Button
            key={app}
            variant={selected === app ? "secondary" : "ghost"}
            disabled={busy}
            aria-pressed={selected === app}
            onClick={() => {
              clearCredentials();
              setEditing(null);
              setHost("");
              setName("");
              setNotice(null);
              setSelected(app);
            }}
          >
            {app}
          </Button>
        ))}
      </div>
      <h2 className="text-lg font-medium">{selected}</h2>
      {provider ? (
        <>
          {businessAccounts.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">{row.name}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (provider === "fakturownia" && row.endpoint !== businessEndpoint) {
                      void run(async () => {
                        await connectMcpOauth(row.id);
                      });
                      return;
                    }
                    clearCredentials();
                    setEditing(row);
                    setName(row.name);
                    setHost(
                      provider === "fakturownia" && row.description.startsWith("https://")
                        ? new URL(row.description).hostname
                        : "",
                    );
                  }}
                >{t`Reconnect`}</Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await rpc.mcp.servers.remove({ id: row.id });
                    })
                  }
                >{t`Disconnect`}</Button>
              </div>
            </div>
          ))}
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void connectBusiness();
            }}
          >
            <Input
              aria-label={t`Account name`}
              placeholder={t`Account name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              autoComplete="off"
            />
            {provider === "fakturownia" ? (
              <>
                <Input
                  aria-label={t`Account domain`}
                  placeholder="example.fakturownia.pl"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  autoComplete="off"
                  required
                />
                <Button
                  type="button"
                  disabled={busy || !actor || !host.trim()}
                  onClick={() => void connectFakturowniaReads()}
                >{t`Connect with Fakturownia`}</Button>
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Browser sign-in enables read access. An API token enables invoice creation and
                    email with approval.
                  </Trans>
                </p>
              </>
            ) : null}
            {provider === "wfirma" ? (
              <>
                <Input
                  type="password"
                  aria-label={t`Access key`}
                  placeholder={t`Access key`}
                  value={accessKey}
                  onChange={(event) => setAccessKey(event.target.value)}
                  autoComplete="new-password"
                  required
                  maxLength={1024}
                />
                <Input
                  type="password"
                  aria-label={t`Secret key`}
                  placeholder={t`Secret key`}
                  value={secretKey}
                  onChange={(event) => setSecretKey(event.target.value)}
                  autoComplete="new-password"
                  required
                  maxLength={1024}
                />
                <Input
                  type="password"
                  aria-label={t`App key`}
                  placeholder={t`App key`}
                  value={appKey}
                  onChange={(event) => setAppKey(event.target.value)}
                  autoComplete="new-password"
                  required
                  maxLength={1024}
                />
              </>
            ) : (
              <Input
                type="password"
                aria-label={t`API token`}
                placeholder={t`API token`}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
                required
                maxLength={1024}
              />
            )}
            <Button type="submit" disabled={busy || !actor}>
              {editing ? t`Reconnect` : t`Connect account`}
            </Button>
          </form>
        </>
      ) : selected === "Gmail" ? (
        <>
          {gmailAccounts.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3">
              <span>{row.displayName}</span>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await rpc.connections.revoke({ connectionId: row.id });
                  })
                }
              >{t`Disconnect`}</Button>
            </div>
          ))}
          <Button
            disabled={busy || !actor}
            onClick={() => void connectGmail()}
          >{t`Connect Gmail`}</Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            <Trans>Link your Telegram bot. Existing personal conversations are not included.</Trans>
          </p>
          {telegramAccounts.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3">
              <span>{row.botName}</span>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await rpc.messaging.identities.unlink({ identityId: row.id });
                  })
                }
              >{t`Disconnect`}</Button>
            </div>
          ))}
          <Button
            disabled={
              busy ||
              !actor ||
              !botId ||
              !messaging?.providers.some(
                (value) => value === "telegram" || value.startsWith("telegram-"),
              )
            }
            onClick={() =>
              void run(async () => {
                if (botId) {
                  const link = await rpc.messaging.link.start({ botId });
                  setNotice(t`Send this code to your office bot: ${link.code}`);
                }
              })
            }
          >{t`Link Telegram bot`}</Button>
          {!messaging?.providers.some(
            (value) => value === "telegram" || value.startsWith("telegram-"),
          ) ? (
            <p className="text-sm text-muted-foreground">
              <Trans>The office administrator must configure the Telegram bot first.</Trans>
            </p>
          ) : null}
        </>
      )}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

/** Personal MCP connections never configure deployment-wide provider credentials. */
export function IntegrationSetup({ onDone, botId }: { onDone?: () => void; botId?: string }) {
  const { t } = useLingui();
  const [endpoint, setEndpoint] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IntegrationCatalogResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const remoteResults = [
    ...new Map(
      results.flatMap((result) =>
        result.surfaces
          .filter((surface) => surface.kind === "mcp" && surface.source?.startsWith("https://"))
          .map(
            (surface) =>
              [surface.source!, { name: result.name, endpoint: surface.source! }] as const,
          ),
      ),
    ).values(),
  ];
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, t`Could not connect`));
    } finally {
      setBusy(false);
    }
  }

  async function connect(name: string, url: string) {
    await run(async () => {
      const existing = (await rpc.mcp.servers.list()).find((server) => server.endpoint === url);
      const server =
        existing ??
        (await rpc.mcp.servers.create({
          slug: `integration-${newClientId().slice(0, 8)}`,
          name,
          transport: "streamable_http",
          endpoint: url,
        }));
      const result = await connectMcpOauth(server.id);
      if (result === "cancelled") return;
      if (botId) await rpc.mcp.assignments.approve({ botId, serverId: server.id });
      setConnected((current) => [...current, url]);
    });
  }

  return (
    <div className="space-y-6">
      <OfficeConnections botId={botId} />
      <h1 className="text-[32px] font-medium text-foreground">
        <Trans>Add MCP server</Trans>
      </h1>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const response = await rpc.capabilities.catalogSearch({
              query,
              usePublicCatalog: true,
            });
            setResults(response.results);
            setSearched(true);
          });
        }}
      >
        <Input
          aria-label={t`Search apps`}
          placeholder={t`Search apps`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={busy || !query.trim()}>
          <Trans>Search integrations.sh</Trans>
        </Button>
      </form>
      {remoteResults.map((result) => (
        <div key={result.endpoint} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{result.name}</span>
          <Button
            variant="outline"
            disabled={busy || connected.includes(result.endpoint)}
            onClick={() => void connect(result.name, result.endpoint)}
          >
            {connected.includes(result.endpoint) ? t`Connected` : t`Connect`}
          </Button>
        </div>
      ))}
      {searched && !remoteResults.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No remote MCP servers found</Trans>
        </p>
      ) : null}
      <Disclosure className="text-sm text-muted-foreground" summary={<Trans>Add server URL</Trans>}>
        <div className="mt-3 space-y-3">
          <Input
            aria-label={t`Server URL`}
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://example.com/mcp"
          />
          <Button
            disabled={busy || !endpoint.trim()}
            onClick={() => void connect("MCP server", endpoint.trim())}
          >
            <Trans>Connect</Trans>
          </Button>
        </div>
      </Disclosure>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {onDone ? (
        <Button disabled={busy} onClick={onDone}>
          <Trans>Continue</Trans>
        </Button>
      ) : null}
    </div>
  );
}
