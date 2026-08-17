const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const workerName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const databaseName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const accessAudience = /^[A-Za-z0-9_-]{32,128}$/;

function exactHttpsOrigin(candidate, hostnamePredicate = () => true) {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      hostnamePredicate(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

export function createProductionControlPlaneConfig(environment) {
  const name = environment.VILLAGE_PRODUCTION_WORKER_NAME;
  const origin = exactHttpsOrigin(environment.VILLAGE_PRODUCTION_ORIGIN);
  const routeMode =
    environment.VILLAGE_PRODUCTION_ROUTE_MODE ?? "custom-domain";
  const database = environment.VILLAGE_CLOUDFLARE_D1_DATABASE_NAME;
  const databaseId = environment.VILLAGE_CLOUDFLARE_D1_DATABASE_ID;
  const accessDomain = exactHttpsOrigin(
    environment.CF_ACCESS_TEAM_DOMAIN,
    (hostname) =>
      hostname.endsWith(".cloudflareaccess.com") &&
      hostname !== "cloudflareaccess.com",
  );
  const audience = environment.CF_ACCESS_AUD;
  const originLabels = origin?.hostname.split(".") ?? [];
  const workersDevOrigin =
    originLabels.length === 4 &&
    originLabels[0] === name &&
    originLabels[2] === "workers" &&
    originLabels[3] === "dev";
  if (
    !workerName.test(name ?? "") ||
    !origin ||
    !["custom-domain", "workers-dev"].includes(routeMode) ||
    (routeMode === "workers-dev" && !workersDevOrigin) ||
    (routeMode === "custom-domain" && workersDevOrigin) ||
    !databaseName.test(database ?? "") ||
    !uuid.test(databaseId ?? "") ||
    databaseId === "00000000-0000-0000-0000-000000000000" ||
    !accessDomain ||
    !accessAudience.test(audience ?? "")
  ) {
    throw new Error("VILLAGE_PRODUCTION_CONFIGURATION_INVALID");
  }

  const routeConfiguration =
    routeMode === "workers-dev"
      ? { workers_dev: true }
      : {
          workers_dev: false,
          routes: [{ pattern: origin.hostname, custom_domain: true }],
        };

  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name,
    main: "src/index.ts",
    compatibility_date: "2026-08-12",
    ...routeConfiguration,
    assets: {
      directory: "../web/dist",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*"],
    },
    triggers: { crons: ["17 3 * * *"] },
    durable_objects: {
      bindings: [
        {
          name: "BROWSER_SESSION_COORDINATOR",
          class_name: "BrowserSessionCoordinator",
        },
        { name: "SITE_SESSION_MAILBOX", class_name: "SiteSessionMailbox" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["BrowserSessionCoordinator", "SiteSessionMailbox"],
      },
    ],
    d1_databases: [
      {
        binding: "VILLAGE_DB",
        database_name: database,
        database_id: databaseId,
        migrations_dir: "migrations",
      },
    ],
    vars: {
      VILLAGE_DEPLOYMENT_NAME: "production",
      VILLAGE_AUTH_MODE: "cloudflare-access",
      VILLAGE_ENVIRONMENT: "production",
      VILLAGE_EXPERIMENTAL_CONTINUITY: "disabled",
      VILLAGE_ALLOWED_ORIGINS: origin.origin,
      CF_ACCESS_TEAM_DOMAIN: accessDomain.origin,
      CF_ACCESS_AUD: audience,
    },
  };
}
