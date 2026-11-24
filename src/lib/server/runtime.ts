import { BunContext } from "@effect/platform-bun";
import { FetchHttpClient } from "@effect/platform";
import { Layer, ManagedRuntime, Match } from "effect";
import { CheckoutRefreshLive } from "../../cli/pulse-refresh.ts";
import { ConfigLive } from "./config.ts";
import { ArtifactProbeLive } from "./example/service.ts";
import { ProfileFilesLive } from "./profile/files.ts";
import { ProfileLive } from "./profile/service.ts";
import { LookupHttpLive } from "./profile/lookup-http.ts";
import { PostcodeAreaLive } from "./profile/postcode-area.ts";
import { LocalProfileSettingsLive } from "./profile/local-settings.ts";
import { AddressClientLive } from "./source/locations.ts";
import { NavClientLive, SourceHttpLive } from "./source/nav-client.ts";
import { SourceLive } from "./source/service.ts";
import { GeographyAreasLive } from "./filter/geography-service.ts";
import { FitReviewFilesLive } from "./filter/review-service.ts";
import { FilterSourcePackageResources } from "./filter/service.ts";
import { SourcePoliciesLive } from "./filter/source-policy.ts";
import { MarketLive } from "./market/service.ts";
import { SnapshotStoreLive } from "./snapshot/store.ts";
import { SnapshotPathsLive } from "./snapshot/paths.ts";
import { SnapshotJsonFileLive } from "./snapshot/json-file.ts";
import { SnapshotFactsLive } from "./snapshot/judge-inputs.ts";
import { SnapshotExportLive } from "./snapshot/service.ts";
import { SnapshotCaptureLive } from "./snapshot/capture.ts";
import { ReviewerHarnessLive } from "./judge/harness.ts";
import { JudgeModelPickerLive } from "./judge/model-picker.ts";
import { HarnessReadinessLive } from "./judge/harness-readiness.ts";
import { ReviewerSettingsLive } from "./judge/reviewers.ts";
import { ReviewHostLive } from "./judge/run-information.ts";
import { JudgeIdsLive } from "./judge/session.ts";
import { ReviewSourceLive } from "./judge/workflow-source.ts";
import { DashboardConfigLive } from "./dashboard/config.ts";
import { DashboardRunLive } from "./dashboard/run.ts";
import { NtfyTransportLive } from "./alert/ntfy.ts";
import { DashboardNtfyTestLive } from "./dashboard/local-settings.ts";
import { DashboardServerLive } from "./dashboard/service.ts";
import { DashboardSettingsSuggestionsLive } from "./dashboard/settings-suggestions.ts";
import { DashboardSnapshotLive } from "./dashboard/snapshot.ts";
import { LaunchdScheduleLive } from "./orchestration/schedule-launchd.ts";
import { ScheduleLive } from "./orchestration/schedule.ts";
import { WindowsScheduleLive } from "./orchestration/schedule-windows.ts";
import { AlertProfileLockLive, SourceWriterLockLive } from "./orchestration/workflow-locks.ts";

const sourceClients = Layer.mergeAll(NavClientLive, AddressClientLive).pipe(
  Layer.provide(SourceHttpLive), Layer.provide(FetchHttpClient.layer),
);

const profile = ProfileLive.pipe(Layer.provide(ProfileFilesLive), Layer.provide(BunContext.layer));
const reviewerHarness = ReviewerHarnessLive.pipe(Layer.provide(BunContext.layer));
const judgeModelPicker = JudgeModelPickerLive.pipe(Layer.provide(reviewerHarness), Layer.provide(BunContext.layer));
const postcodeArea = PostcodeAreaLive.pipe(Layer.provide(LookupHttpLive), Layer.provide(FetchHttpClient.layer));
const localProfileSettings = LocalProfileSettingsLive.pipe(Layer.provide(Layer.mergeAll(ProfileFilesLive, judgeModelPicker, postcodeArea)), Layer.provide(BunContext.layer));
const source = SourceLive.pipe(Layer.provide(sourceClients), Layer.provide(BunContext.layer));
const geography = GeographyAreasLive.pipe(Layer.provide(BunContext.layer));
const reviewSource = ReviewSourceLive.pipe(Layer.provide(Layer.mergeAll(profile, source, geography, FilterSourcePackageResources, sourceClients, BunContext.layer)));

const market = MarketLive.pipe(Layer.provide(geography), Layer.provide(FilterSourcePackageResources), Layer.provide(BunContext.layer));

const snapshotPaths = SnapshotPathsLive.pipe(Layer.provide(BunContext.layer));

const snapshotJson = SnapshotJsonFileLive.pipe(Layer.provide(snapshotPaths), Layer.provide(BunContext.layer));

const snapshotFacts = SnapshotFactsLive.pipe(
  Layer.provide(profile), Layer.provide(geography), Layer.provide(FilterSourcePackageResources),
  Layer.provide(market), Layer.provide(BunContext.layer),
);

const snapshotExport = SnapshotExportLive.pipe(Layer.provide(snapshotFacts), Layer.provide(market));

const snapshotCapture = SnapshotCaptureLive.pipe(
  Layer.provide(snapshotExport), Layer.provide(snapshotFacts), Layer.provide(snapshotJson),
  Layer.provide(SnapshotStoreLive), Layer.provide(snapshotPaths), Layer.provide(BunContext.layer),
);

const dashboardConfig = DashboardConfigLive.pipe(Layer.provide(ConfigLive));
const dashboardSnapshot = DashboardSnapshotLive.pipe(Layer.provide(dashboardConfig), Layer.provide(SnapshotStoreLive), Layer.provide(snapshotJson));

const dashboardSuggestions = DashboardSettingsSuggestionsLive.pipe(
  Layer.provide(Layer.mergeAll(dashboardConfig, dashboardSnapshot, localProfileSettings, reviewerHarness, BunContext.layer)),
);

export const PipelineLive = Layer.mergeAll(
  profile, source, geography,
  ProfileFilesLive.pipe(Layer.provide(BunContext.layer)),
  FilterSourcePackageResources, JudgeIdsLive, reviewSource,
  SourceWriterLockLive.pipe(Layer.provide(BunContext.layer)), AlertProfileLockLive,
  Match.value(process.platform).pipe(
    Match.when("win32", () => WindowsScheduleLive),
    Match.when("darwin", () => LaunchdScheduleLive),
    Match.orElse(() => ScheduleLive),
    Layer.provide(BunContext.layer),
  ), SourcePoliciesLive,
  FitReviewFilesLive.pipe(Layer.provide(BunContext.layer)),
  market, SnapshotStoreLive, NtfyTransportLive, snapshotPaths, snapshotJson, snapshotFacts, snapshotExport, snapshotCapture,
  reviewerHarness,
  HarnessReadinessLive.pipe(Layer.provide(BunContext.layer)),
  ReviewerSettingsLive.pipe(Layer.provide(BunContext.layer)),
  ReviewHostLive,
  BunContext.layer,
);

const dashboardRun = DashboardRunLive.pipe(Layer.provide(CheckoutRefreshLive), Layer.provide(dashboardConfig), Layer.provide(PipelineLive));

export const AppLive = Layer.mergeAll(
  PipelineLive, ConfigLive, ArtifactProbeLive.pipe(Layer.provide(BunContext.layer)),
  DashboardServerLive.pipe(
    Layer.provide(dashboardConfig), Layer.provide(dashboardSnapshot), Layer.provide(localProfileSettings), Layer.provide(dashboardRun), Layer.provide(dashboardSuggestions),
    Layer.provide(DashboardNtfyTestLive.pipe(Layer.provide(NtfyTransportLive), Layer.provide(ProfileFilesLive), Layer.provide(BunContext.layer))),
  ),
  dashboardSnapshot,
);

// One runtime for server routes. CLI owns its process scope separately.
export const runtime = ManagedRuntime.make(AppLive);
