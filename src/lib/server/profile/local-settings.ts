import { FileSystem } from "@effect/platform";
import { Clock, Context, Data, Effect, Either, Layer, Option, Predicate } from "effect";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TomlTable } from "smol-toml";
import { parseIsoDate } from "../../contracts/iso-time.ts";
import { claudePickerEfforts, PiModelCatalog, screenListKeys, type LocalReviewer, type LocalSettingsDocument, type LocalSettingsPost, type LocalSettingsSaved, type LocalSettingsUpdate } from "../../contracts/local-settings.ts";
import type { FiltersSettings, ProfileSettings } from "../../contracts/profile-settings.ts";
import { strip } from "../../text-whitespace.ts";
import { PROFILE_TEXT_MAX_BYTES } from "../../contracts/profile.ts";
import { claudeModelAliases } from "../../contracts/reviewer-settings.ts";
import { decodeStrict } from "../../contracts/support.ts";
import { readScreenTerm, screenListView, screenTermPattern, titleScreenTerm } from "../../title-screen-terms.ts";
import { JudgeModelPicker, ModelPickerError } from "../judge/model-picker.ts";
import { decodeModelSettings, modelSettingsFile, type Reviewer } from "../judge/reviewers.ts";
import { installationLockPath, withInstallationLock, WorkflowLockError } from "../orchestration/workflow-locks.ts";
import { installationSetting } from "../shared/installation-paths.ts";
import { physicalPath } from "../shared/paths.ts";
import { sha256 } from "../shared/python-json.ts";
import { parseToml, writeToml } from "../shared/toml.ts";
import { dateToken, decodeProfileId, decodeProfileSettings, parseCadence, pathsFor, replaceModeText } from "./core.ts";
import { ProfileFiles } from "./files.ts";
import { PostcodeAreaTag, postcodeAreaOriginSource } from "./postcode-area.ts";
import { ntfySettingsView, NtfySettingsError, readNtfySettings, saveNtfySettings } from "./ntfy-settings.ts";
import { checkNarrative } from "./narrative.ts";
import { rewriteScheduleConfig } from "./schedule-config.ts";
import { parsePeriod, validateScheduleInput } from "./schedule-period.ts";
import { decodeFilters, decodeJudge, decodeScreen, defaultPreferences, mergePreferences } from "./settings.ts";

export interface LocalSettingsTarget {
  readonly root: string;
  readonly profileId: string;
}

type CurrentSettings = Omit<LocalSettingsDocument, "csrf_token">;

export class LocalSettingsError extends Data.TaggedError("LocalSettingsError")<{
  readonly code: "invalid" | "changed" | "busy" | "unavailable";
  readonly message?: string;
}> {}

const failure = (code: LocalSettingsError["code"] = "unavailable", message?: string) =>
  new LocalSettingsError(message === undefined ? { code } : { code, message });

const maximum = 64 * 1024;
const emptyTable = (): TomlTable => Object.create(null);

const serialize = (table: TomlTable) => Either.gen(function* () {
  const output = yield* Either.mapLeft(writeToml(table), () => failure("invalid"));

  if (!output.isWellFormed() || new TextEncoder().encode(output).byteLength > maximum) {
    return yield* Either.left(failure("invalid"));
  }

  const roundTrip = yield* Either.mapLeft(parseToml(output), () => failure("invalid"));

  if (!isDeepStrictEqual(roundTrip, table)) {
    return yield* Either.left(failure("invalid"));
  }

  return output;
});

const candidateAllowed = (current: Reviewer, choice: LocalReviewer, catalog: PiModelCatalog | null): boolean => {
  if (current.harness === choice.harness && current.provider === choice.provider && current.model === choice.model && current.effort === choice.effort) return true;

  return choice.harness === "claude-code"
    ? choice.provider === "anthropic" && claudeModelAliases.some((alias) => alias === choice.model) && claudePickerEfforts.some((effort) => effort === choice.effort)
    : catalog?.some((model) => model.provider === choice.provider && model.model === choice.model && model.efforts.includes(choice.effort)) === true;
};

const replaceModel = (text: string, update: Extract<LocalSettingsUpdate, { kind: "model" }>, catalog: PiModelCatalog | null) => Either.gen(function* () {
  const models = yield* decodeModelSettings(text);
  const current = models[update.step];

  if (!candidateAllowed(current, update, catalog)) {
    return yield* Either.left(failure("invalid"));
  }

  if (current.harness === update.harness && current.provider === update.provider && current.model === update.model && current.effort === update.effort) return text;
  const table = yield* parseToml(text);
  const step = table[update.step];

  if (!Predicate.isRecord(step)) return yield* Either.left(failure());
  step.harness = update.harness;
  step.model = update.harness === "pi" ? `${update.provider}/${update.model}` : update.model;
  step.effort = update.effort;
  const output = yield* serialize(table);
  yield* decodeModelSettings(output);

  return output;
});

const replaceRejudge = (text: string, { values, model }: Extract<LocalSettingsUpdate, { kind: "rejudge" }>, catalog: PiModelCatalog | null) => Either.gen(function* () {
  const models = yield* decodeModelSettings(text);
  const manualPi = model?.harness === "pi" && !catalog?.some((entry) => entry.provider === model.provider && entry.model === model.model);

  if (model !== null && !manualPi && !candidateAllowed(models.rejudge, model, catalog)) return yield* Either.left(failure("invalid"));
  const table = yield* parseToml(text);
  const step = table.rejudge;

  if (!Predicate.isRecord(step)) return yield* Either.left(failure());
  step.levels = [...values.levels];
  step.same_as_judge = values.same_as_judge;

  if (model !== null) {
    step.harness = model.harness;
    step.model = model.harness === "pi" ? `${model.provider}/${model.model}` : model.model;
    step.effort = model.effort;
  }

  const output = isDeepStrictEqual(table, yield* parseToml(text)) ? text : yield* serialize(table);
  yield* decodeModelSettings(output);

  return output;
});

const replaceTerms = (text: string, values: readonly string[]) => Either.gen(function* () {
  const filters = yield* decodeFilters(text);

  if (isDeepStrictEqual(filters.jobs?.excluded_title_terms ?? [], values)) return text;
  const table = yield* parseToml(text);
  const jobs = table.jobs ?? emptyTable();

  if (!Predicate.isRecord(jobs)) return yield* Either.left(failure());
  jobs.excluded_title_terms = [...values];
  table.jobs = jobs;
  const output = yield* serialize(table);
  yield* decodeFilters(output);

  return output;
});

type ProfileUpdate = Exclude<LocalSettingsUpdate, { kind: "model" | "rejudge" | "excluded_title_terms" | "notifications" | "location" }>;

type LocationUpdate = Extract<LocalSettingsUpdate, { kind: "location" }>;

const locationView = (filters: FiltersSettings, legacyGeography?: TomlTable): LocalSettingsDocument["filters"]["location"] => {
  const { home_postcode, home_label, origin_source, origin_latitude, origin_longitude, radius_km } = filters.geography ?? {};
  const postcode = strip(home_postcode ?? "");
  const area = legacyGeography?.area_postcode;

  const confirmed = postcode !== "" && (area === undefined || area === postcode)
    && origin_source !== undefined && origin_latitude !== undefined && origin_longitude !== undefined;

  const label = home_label?.startsWith(postcode + " ") ? home_label.slice(postcode.length + 1) : home_label;

  return { home_postcode: postcode, radius_km: Number(radius_km ?? defaultPreferences.radius_km), place: confirmed ? label ?? null : null };
};

const replaceLocation = (text: string, values: LocationUpdate["values"], lookup: PostcodeAreaTag["Type"]["lookup"]) => Effect.gen(function* () {
  const filters = yield* decodeFilters(text);
  const table = yield* parseToml(text);
  const geography = table.geography ?? emptyTable();

  if (!Predicate.isRecord(geography)) return yield* failure();
  const { home_postcode, radius_km } = values;
  const saved = locationView(filters, geography);

  if (home_postcode !== saved.home_postcode || saved.place === null) {
    const area = yield* lookup(home_postcode).pipe(
      Effect.mapError(() => failure("invalid", "Could not look up this postcode. Check the postcode and try again. No location was saved.")),
    );

    const date = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 10);

    geography.home_label = area.poststed;
    geography.origin_latitude = area.latitude;
    geography.origin_longitude = area.longitude;
    geography.origin_source = postcodeAreaOriginSource(area, date);
  }

  geography.home_postcode = home_postcode;
  geography.radius_km = radius_km === saved.radius_km ? geography.radius_km ?? radius_km : radius_km;
  delete geography.area_postcode;
  delete geography.preferred_municipalities;
  delete geography.nearby_municipalities;
  table.geography = geography;

  const updated = isDeepStrictEqual(table, yield* parseToml(text)) ? text : yield* serialize(table);
  const checked = yield* decodeFilters(updated);
  yield* mergePreferences(checked, {});

  return { updated, location: locationView(checked) };
});

const readSchedule = (config: ProfileSettings): Either.Either<ProfileUpdateSchedule, LocalSettingsError> => Either.gen(function* () {
  const cadence = yield* Either.mapLeft(parseCadence(config.policy), () => failure());
  const expression = config.schedule?.schedule ?? (cadence.kind === "weekly" ? "weekly" : "every 2 weeks");
  const period = parsePeriod(expression, "2000-01-01");
  const anchor = config.schedule?.anchor;

  return { expression, anchor: anchor !== undefined ? dateToken(anchor)
    : Either.isRight(period) && period.right.anchor !== null ? cadence.anchor : null };
});

type ProfileUpdateSchedule = Extract<ProfileUpdate, { kind: "schedule" }>["values"];

const replaceSchedule = (text: string, { expression, anchor }: ProfileUpdateSchedule) => Either.gen(function* () {
  yield* Either.mapLeft(validateScheduleInput(anchor === null ? { schedule: expression } : { schedule: expression, anchor }),
    (error) => failure("invalid", error.message));
  const current = yield* Either.flatMap(decodeProfileSettings(text), readSchedule);

  if (current.expression === expression && current.anchor === anchor) return text;
  const period = expression === "never" ? null : yield* Either.mapLeft(parsePeriod(expression, "2000-01-01"), () => failure("invalid"));

  if (period?.anchor && anchor === null) return yield* Either.left(failure("invalid", "Enter a start date for the interval."));
  const date = anchor === null ? null : Option.getOrUndefined(parseIsoDate(anchor))?.text;

  if (date === undefined) return yield* Either.left(failure("invalid", "Enter a valid start date."));
  const cadence = period?.kind === "weekly" ? "weekly" : period?.kind === "every_n_weeks" && period.n === 2 ? "fortnightly" : null;
  const output = yield* Either.mapLeft(rewriteScheduleConfig(text, expression, date, cadence), (error) => failure("invalid", error.message));

  if (new TextEncoder().encode(output).byteLength > maximum) return yield* Either.left(failure("invalid"));
  const config = yield* Either.mapLeft(decodeProfileSettings(output), () => failure("invalid"));
  yield* Either.mapLeft(parseCadence(config.policy), () => failure("invalid"));

  return output;
});

const replaceProfileInput = (text: string, update: ProfileUpdate) => Either.gen(function* () {
  if (update.kind === "narrative") {
    if (text === update.values) return text;
    const problem = checkNarrative(update.values, { requireTemplate: false })[0];

    return problem === undefined ? update.values : yield* Either.left(failure("invalid", problem));
  }

  if (update.kind === "schedule") return yield* replaceSchedule(text, update.values);

  if (update.kind === "search_mode") return yield* Either.mapLeft(replaceModeText(text, update.values), () =>
    failure("invalid", 'Could not safely save search mode. In profile.toml, use a separate mode = "passive" or mode = "active" line under [policy].'));
  const table = yield* parseToml(text);

  switch (update.kind) {
    case "filters": {
      const { excluded_municipalities, excluded_employers, allowed_occupation_categories } = update.values;
      const geography = table.geography ?? emptyTable();
      const jobs = table.jobs ?? emptyTable();

      if (!Predicate.isRecord(jobs) || !Predicate.isRecord(geography)) return yield* Either.left(failure());

      if (geography.excluded_municipalities !== undefined || excluded_municipalities.length) {
        geography.excluded_municipalities = [...excluded_municipalities];
        table.geography = geography;
      }

      if (jobs.excluded_employers !== undefined || excluded_employers.length) jobs.excluded_employers = [...excluded_employers];

      if (jobs.allowed_occupation_categories !== undefined || allowed_occupation_categories.length) jobs.allowed_occupation_categories = [...allowed_occupation_categories];

      if (table.jobs !== undefined || Object.keys(jobs).length) table.jobs = jobs;
      break;
    }

    case "judge": {
      const original = yield* decodeJudge(text);

      if (isDeepStrictEqual(original.jobs?.preferred_terms ?? [], update.values)) return text;
      const jobs = emptyTable();
      jobs.preferred_terms = [...update.values];
      table.jobs = jobs;
      break;
    }

    case "screen": {
      const original = yield* decodeScreen(text);

      for (const key of screenListKeys) {
        const terms = update.values[key];

        if (terms === undefined) continue;

        if (!terms.every((term) => titleScreenTerm.test(term))) return yield* Either.left(failure("invalid"));

        const patterns = original[key] ?? [];
        const { advanced, terms: previous } = screenListView(patterns);

        if (isDeepStrictEqual(terms, previous)) continue;
        const retained = new Map<string, string[]>();

        for (const pattern of patterns) {
          const term = readScreenTerm(pattern);

          if (term === undefined) continue;
          const entries = retained.get(term);

          if (entries) entries.push(pattern);
          else retained.set(term, [pattern]);
        }

        table[key] = [...new Set(terms)].flatMap((term) => retained.get(term) ?? [screenTermPattern(term)]).concat(advanced);
      }

      break;
    }

  }

  const unchanged = isDeepStrictEqual(table, yield* parseToml(text));
  const output = unchanged ? text : yield* serialize(table);
  const invalid = () => failure("invalid");

  switch (update.kind) {
    case "filters": {
      const filters = yield* Either.mapLeft(decodeFilters(output), invalid);
      yield* Either.mapLeft(mergePreferences(filters, {}), (error) => failure("invalid", error.message));
      break;
    }

    case "judge": yield* Either.mapLeft(decodeJudge(output), invalid); break;
    case "screen": yield* Either.mapLeft(decodeScreen(output), invalid); break;
  }

  return output;
});

type TestModel = Extract<LocalSettingsPost, { kind: "test_model" }>;

const decodeCatalog = decodeStrict(PiModelCatalog);
const catalogLimit = 1_000_000;

export class LocalProfileSettings extends Context.Tag("pulse/LocalProfileSettings")<LocalProfileSettings, {
  readonly read: (target: LocalSettingsTarget) => Effect.Effect<CurrentSettings, LocalSettingsError>;
  readonly save: (target: LocalSettingsTarget, update: LocalSettingsUpdate) => Effect.Effect<typeof LocalSettingsSaved.Type, LocalSettingsError>;
  readonly refreshModels: (target: LocalSettingsTarget) => Effect.Effect<PiModelCatalog, LocalSettingsError | ModelPickerError>;
  readonly testModel: (target: LocalSettingsTarget, update: TestModel) => Effect.Effect<void, LocalSettingsError | ModelPickerError>;
}>() {}

export const LocalProfileSettingsLive = Layer.effect(LocalProfileSettings, Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const fs = yield* FileSystem.FileSystem;
  const picker = yield* JudgeModelPicker;
  const postcode = yield* PostcodeAreaTag;
  const modelOperation = yield* Effect.makeSemaphore(1);

  const confined = (path: string) => Effect.gen(function* () {
    const physical = yield* physicalPath(path).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    if (path !== physical) return yield* failure();

    return path;
  });

  const read = (root: string, path: string, limit = maximum) => confined(path).pipe(Effect.flatMap(() => files.read(root, path, limit)));

  const selected = ({ root, profileId }: LocalSettingsTarget) => Effect.gen(function* () {
    const id = yield* decodeProfileId(profileId);
    const directory = join(root, "local_only", "profiles", id);
    const text = yield* read(root, join(directory, "profile.toml"));
    const profile = yield* decodeProfileSettings(text);

    if (profile.profile.id !== id) return yield* failure();
    const paths = yield* pathsFor(root, id, profile);

    return {
      id, profile, text, models: installationSetting(root, modelSettingsFile), filters: join(directory, "filters.toml"),
      judge: join(directory, "judge.toml"), screen: join(directory, "screen.toml"), schedule: paths.profile_file, search_mode: paths.profile_file,
      narrative: paths.narrative_file, catalog: installationSetting(root, "local_only/pi-model-catalog.json"),
    };
  });

  const canonicalTarget = (target: LocalSettingsTarget) => files.root(target.root).pipe(Effect.flatMap((root) =>
    root === target.root ? Effect.succeed(target) : Effect.fail(failure()),
  ));

  const readCatalog = (root: string, path: string) => confined(path).pipe(
    Effect.flatMap(() => files.read(root, path, catalogLimit)),
    Effect.flatMap((text) => Effect.try(() => decodeCatalog(JSON.parse(text)))),
    Effect.flatMap((decoded) => decoded),
    Effect.orElseSucceed(() => null),
  );

  const runModelOperation = <A, E>(operation: Effect.Effect<A, E>) => modelOperation.withPermitsIfAvailable(1)(operation).pipe(
    Effect.flatMap((result) => Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(failure("busy"))),
    Effect.mapError((error) => error instanceof ModelPickerError || error instanceof LocalSettingsError ? error : failure()),
  );

  const ntfyContext = yield* Effect.context<FileSystem.FileSystem | ProfileFiles>();

  return {
    read: (target) => Effect.gen(function* () {
      const { root } = yield* canonicalTarget(target);
      const paths = yield* selected(target);
      const modelText = yield* read(root, paths.models);
      const models = yield* decodeModelSettings(modelText);
      const filterText = yield* read(root, paths.filters);
      const filters = yield* decodeFilters(filterText);
      const { geography } = yield* parseToml(filterText);

      const judge = yield* read(root, paths.judge).pipe(
        Effect.flatMap((text) => Either.map(decodeJudge(text), (value) => ({ revision: sha256(text), preferred_terms: value.jobs?.preferred_terms ?? [] }))),
        Effect.orElseSucceed(() => null),
      );

      const screen = yield* read(root, paths.screen).pipe(
        Effect.flatMap((text) => Either.map(decodeScreen(text), (settings) => {
          const values: Partial<Record<typeof screenListKeys[number], readonly string[]>> = {};
          const advanced: typeof values = {};

          for (const key of screenListKeys) {
            const patterns = settings[key];

            if (patterns === undefined) continue;
            const view = screenListView(patterns);
            values[key] = view.terms;
            advanced[key] = view.advanced;
          }

          return { revision: sha256(text), values, advanced };
        })),
        Effect.orElseSucceed(() => null),
      );

      const schedule = Either.getOrNull(Either.map(readSchedule(paths.profile), (value) => ({ revision: sha256(paths.text), ...value })));

      const narrative = yield* read(root, paths.narrative, PROFILE_TEXT_MAX_BYTES).pipe(
        Effect.map((text) => ({ revision: sha256(text), text })), Effect.orElseSucceed(() => null),
      );

      const document = {
        profile_id: paths.id,
        models: { revision: sha256(modelText), steps: {
          screen: reviewerFields(models.screen), judge: reviewerFields(models.judge),
          rejudge: reviewerFields(models.rejudge), calibrate: reviewerFields(models.calibrate),
        }, pi_catalog: yield* readCatalog(root, paths.catalog) },
        filters: {
          revision: sha256(filterText), excluded_title_terms: filters.jobs?.excluded_title_terms ?? [],
          location: locationView(filters, Predicate.isRecord(geography) ? geography : undefined),
          excluded_municipalities: filters.geography?.excluded_municipalities ?? [],
          excluded_employers: filters.jobs?.excluded_employers ?? [],
          allowed_occupation_categories: filters.jobs?.allowed_occupation_categories ?? [],
        },
        search_mode: { revision: sha256(paths.text), mode: paths.profile.policy.mode },
        judge, screen, schedule, narrative,
        notifications: yield* readNtfySettings(root).pipe(Effect.provide(ntfyContext), Effect.map(ntfySettingsView), Effect.orElseSucceed(() => null)),
      };

      return models.rejudgeOptions === undefined ? document : { ...document, rejudge: models.rejudgeOptions };
    }).pipe(Effect.mapError(() => failure())),
    save: (target, update) => Effect.gen(function* () {
      const { root } = yield* canonicalTarget(target);

      if (update.kind === "notifications") {
        yield* selected(target);

        return { revision: yield* saveNtfySettings(root, update.revision, update.values).pipe(Effect.provide(ntfyContext)) };
      }

      yield* confined(installationLockPath(root));

      return yield* withInstallationLock(root, () => Effect.gen(function* () {
        const paths = yield* selected(target);
        const key = update.kind === "model" || update.kind === "rejudge" ? "models" : update.kind;
        const path = paths[key === "excluded_title_terms" || key === "location" ? "filters" : key];
        const limit = update.kind === "narrative" ? PROFILE_TEXT_MAX_BYTES : maximum;
        const original = yield* read(root, path, limit);

        if (sha256(original) !== update.revision) return yield* failure("changed");

        let updated: string;
        let location: LocalSettingsDocument["filters"]["location"] | undefined;

        if (update.kind === "location") ({ updated, location } = yield* replaceLocation(original, update.values, postcode.lookup));
        else if (update.kind === "model") updated = yield* replaceModel(original, update, yield* readCatalog(root, paths.catalog));
        else if (update.kind === "rejudge") updated = yield* replaceRejudge(original, update, yield* readCatalog(root, paths.catalog));
        else updated = yield* (update.kind === "excluded_title_terms" ? replaceTerms(original, update.values) : replaceProfileInput(original, update));

        if (updated !== original) {
          // Cooperating writers hold the same installation lock. Recheck the
          // file as a guard against a manual edit during validation.
          if (original !== (yield* read(root, path, limit))) return yield* failure("changed");
          yield* files.replace(root, path, updated);
        }

        const revision = sha256(updated);

        return location === undefined ? { revision } : { revision, location };
      }));
    }).pipe(Effect.mapError((error) => error instanceof LocalSettingsError ? error : failure(error instanceof NtfySettingsError ? error.code
      : error instanceof WorkflowLockError && error.code === "busy" ? "busy" : "unavailable"))),
    refreshModels: (target) => runModelOperation(Effect.gen(function* () {
      const { root } = yield* canonicalTarget(target);
      const { catalog } = yield* selected(target);
      yield* confined(catalog);
      const candidates = yield* picker.discoverPi;
      const data = JSON.stringify(candidates);

      if (data.length > catalogLimit) return yield* failure();
      yield* confined(catalog);

      if (yield* files.check(root, catalog, "File")) yield* files.replace(root, catalog, data);
      else yield* files.create(root, catalog, data);

      return candidates;
    })),
    testModel: (target, choice) => runModelOperation(Effect.gen(function* () {
      const { root } = yield* canonicalTarget(target);
      const paths = yield* selected(target);
      const original = yield* read(root, paths.models);

      if (sha256(original) !== choice.revision) return yield* failure("changed");
      const current = (yield* decodeModelSettings(original))[choice.step];

      if (!candidateAllowed(current, choice, yield* readCatalog(root, paths.catalog))) return yield* failure("invalid");

      const { harness, provider, model, effort } = choice;
      yield* picker.test({ ...current, harness, provider, model, effort });
    })),
  };
}));

const reviewerFields = ({ harness, provider, model, effort }: LocalReviewer): LocalReviewer => ({ harness, provider, model, effort });
