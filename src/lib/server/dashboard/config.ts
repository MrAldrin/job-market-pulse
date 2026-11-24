import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { isAbsolute, join } from "node:path";
import { ProfileId } from "../../contracts/profile.ts";
import { PulseConfig } from "../config.ts";
import { PhoneProfileId } from "../feedback/phone-store-schema.ts";
import { StarredInstanceId } from "../feedback/starred-jobs.ts";
import type { LocalSettingsTarget } from "../profile/local-settings.ts";
import { loginCredentials, serveIdentity, type Login, type ServeIdentity } from "./auth.ts";
import { DashboardError } from "./errors.ts";

export interface StarredCapability {
  readonly sourceInstance: string;
  readonly profileId: string;
  readonly token: Redacted.Redacted<string>;
}

export const starredTokenPattern = /^[A-Za-z0-9_-]{43,256}(?![\s\S])/;
const isProfileId = Schema.is(PhoneProfileId);
const isInstanceId = Schema.is(StarredInstanceId);

export interface DashboardSettings {
  readonly mode: "local" | "railway";
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly dataDir: string;
  readonly snapshotFile: string | null;
  readonly snapshotDb: string;
  readonly feedbackDb: string;
  readonly feedbackProfile: string | null;
  readonly starred: StarredCapability | null;
  readonly login: Login | null;
  readonly localSettings?: LocalSettingsTarget;
  readonly desktopCloseToken?: Redacted.Redacted<string>;
  readonly serve?: ServeIdentity;
}

export class DashboardConfig extends Context.Tag("pulse/DashboardConfig")<DashboardConfig, DashboardSettings>() {}

const localSettingsTarget = Effect.gen(function* () {
  const root = yield* Config.option(Config.string("PULSE_LOCAL_SETTINGS_ROOT"));
  const id = yield* Config.option(Config.string("PULSE_LOCAL_SETTINGS_PROFILE"));

  if (Option.isNone(root) && Option.isNone(id)) return {};

  if (Option.isNone(root) || !isAbsolute(root.value) || Option.isNone(id) || !Schema.is(ProfileId)(id.value)) {
    return yield* new DashboardError({ message: "Local settings require an absolute installation root and a valid profile ID" });
  }

  return { localSettings: { root: root.value, profileId: id.value } };
});

const settings = Effect.gen(function* () {
  const { dataDir } = yield* PulseConfig;
  const requestedMode = yield* Config.string("PULSE_DASHBOARD_MODE").pipe(Config.withDefault("local"));
  const railwayProject = yield* Config.option(Config.string("RAILWAY_PROJECT_ID"));
  const railwayEnvironment = yield* Config.option(Config.string("RAILWAY_ENVIRONMENT_ID"));
  const port = yield* Config.integer("PORT").pipe(Config.withDefault(8770));
  const hosts = yield* Config.string("DIGEST_VIEW_ALLOWED_HOSTS").pipe(Config.withDefault(""));
  const bind = yield* Config.option(Config.string("HOST"));
  const socket = yield* Config.option(Config.string("SOCKET_PATH"));
  const addressHeader = yield* Config.option(Config.string("ADDRESS_HEADER"));
  const serveOrigin = yield* Config.option(Config.string("PULSE_DASHBOARD_SERVE_ORIGIN"));
  const serveOwner = yield* Config.option(Config.string("PULSE_DASHBOARD_SERVE_OWNER"));
  const file = yield* Config.option(Config.string("PULSE_DASHBOARD_SNAPSHOT"));
  const user = yield* Config.option(Config.redacted("DIGEST_VIEW_USER"));
  const password = yield* Config.option(Config.redacted("DIGEST_VIEW_PASSWORD"));
  const secret = yield* Config.option(Config.redacted("DIGEST_VIEW_SESSION_SECRET"));
  const feedbackProfile = yield* Config.option(Config.string("DIGEST_VIEW_FEEDBACK_PROFILE"));
  const instance = yield* Config.option(Config.string("DIGEST_VIEW_STARRED_INSTANCE"));
  const starredProfile = yield* Config.option(Config.string("DIGEST_VIEW_STARRED_PROFILE"));
  const token = yield* Config.option(Config.redacted("DIGEST_VIEW_STARRED_TOKEN"));

  if (requestedMode !== "local" && requestedMode !== "railway") {
    return yield* new DashboardError({ message: "PULSE_DASHBOARD_MODE must be local or railway" });
  }

  if (port < 1 || port > 65535) return yield* new DashboardError({ message: "PORT must be between 1 and 65535" });
  const mode = Option.isSome(railwayProject) || Option.isSome(railwayEnvironment) ? "railway" : requestedMode;

  if (Option.isSome(addressHeader) && addressHeader.value !== "") {
    return yield* new DashboardError({ message: "ADDRESS_HEADER must be unset or empty; dashboard identity requires the native socket" });
  }

  if (mode === "local" && ((Option.isSome(bind) && bind.value !== "127.0.0.1") || (Option.isSome(socket) && socket.value !== ""))) {
    return yield* new DashboardError({ message: "Local dashboard must bind to 127.0.0.1 over TCP" });
  }

  let serve: ServeIdentity | null = null;

  if (mode === "local" && (Option.isSome(serveOrigin) || Option.isSome(serveOwner))) {
    serve = serveIdentity(Option.getOrElse(serveOrigin, () => ""), Option.getOrElse(serveOwner, () => ""));

    if (serve === null) return yield* new DashboardError({ message: "Tailscale Serve requires one exact HTTPS ts.net origin and an owner login" });

    for (const name of ["ORIGIN", "HOST_HEADER", "PROTOCOL_HEADER", "PORT_HEADER"]) {
      const value = yield* Config.string(name).pipe(Config.withDefault(""));

      if (value !== "") return yield* new DashboardError({ message: "Tailscale Serve does not support adapter origin overrides" });
    }
  }

  const anyLogin = Option.isSome(user) || Option.isSome(password) || Option.isSome(secret);
  let login: Login | null = null;

  if (anyLogin || mode === "railway") {
    if (Option.isNone(user) || Option.isNone(password) || Option.isNone(secret)) {
      return yield* new DashboardError({ message: "Login requires DIGEST_VIEW_USER, DIGEST_VIEW_PASSWORD and DIGEST_VIEW_SESSION_SECRET" });
    }

    const username = Redacted.value(user.value);
    const pass = Redacted.value(password.value);
    const material = Redacted.value(secret.value);

    if (!username || Array.from(pass).length < 16) {
      return yield* new DashboardError({ message: "Login requires a username and a password of at least 16 characters" });
    }

    login = loginCredentials(username, pass, material);

    if (!login) return yield* new DashboardError({ message: "DIGEST_VIEW_SESSION_SECRET must be at least 32 characters" });
  }

  const configuredHosts = hosts.split(",").map((host) => host.trim()).filter(Boolean);
  const allowedHosts = configuredHosts.length ? configuredHosts : mode === "local" ? [`127.0.0.1:${port}`, `localhost:${port}`] : [];

  if (allowedHosts.some((host) => /[\s/\\?#@]/.test(host))) {
    return yield* new DashboardError({ message: "DIGEST_VIEW_ALLOWED_HOSTS must contain exact host entries" });
  }

  if (mode === "railway" && Option.isSome(file)) {
    return yield* new DashboardError({ message: "Hosted mode reads only the saved snapshot database" });
  }

  if (Option.isSome(file) && !file.value) return yield* new DashboardError({ message: "PULSE_DASHBOARD_SNAPSHOT must not be empty" });

  if (mode === "local" && Option.isSome(feedbackProfile) && !isProfileId(feedbackProfile.value)) {
    return yield* new DashboardError({ message: "DIGEST_VIEW_FEEDBACK_PROFILE is invalid" });
  }

  let starred: StarredCapability | null = null;

  if (mode === "local" && (Option.isSome(instance) || Option.isSome(starredProfile) || Option.isSome(token))) {
    if (Option.isNone(instance) || !isInstanceId(instance.value) || Option.isNone(starredProfile)
      || !isProfileId(starredProfile.value) || Option.isNone(token) || !starredTokenPattern.test(Redacted.value(token.value))) {
      return yield* new DashboardError({ message: "Starred-jobs capability settings are incomplete or invalid" });
    }

    starred = { sourceInstance: instance.value, profileId: starredProfile.value, token: token.value };
  }

  const editor = mode === "local" ? yield* localSettingsTarget : {};
  const desktopCloseToken = yield* Config.option(Config.redacted("PULSE_DESKTOP_CLOSE_TOKEN"));

  const desktop = editor.localSettings !== undefined && Option.isSome(desktopCloseToken)
    && /^[0-9a-f]{64}$/u.test(Redacted.value(desktopCloseToken.value)) ? { desktopCloseToken: desktopCloseToken.value } : {};

  const config = {
    ...editor, ...desktop,
    mode, port, allowedHosts, dataDir, login, starred, feedbackProfile: mode === "local" ? Option.getOrNull(feedbackProfile) : null,
    snapshotFile: Option.getOrNull(file),
    snapshotDb: join(dataDir, "digests.sqlite"),
    feedbackDb: join(dataDir, "shortlist-feedback.sqlite3"),
  } satisfies DashboardSettings;

  return serve === null ? config : { ...config, serve };
});

export const DashboardConfigLive = Layer.effect(DashboardConfig, settings);
export const dashboardConfigTest = (value: DashboardSettings) => Layer.succeed(DashboardConfig, value);
