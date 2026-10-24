using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GLTFast;
using GLTFast.Logging;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace MargoMesh.Unity.Editor {
    /// <summary>Opt-in target import through public glTFast and Unity APIs. Raw GLB assets are never modified.</summary>
    public static partial class ImportCompanion {
        const string PartialRecovery = "Owned output may be partially updated. Reimport the complete valid model/profile/atlas only when every output remains ownership-recorded. An unrecorded/conflicting file requires explicit user review and manual recovery; it is never adopted. Require IsCurrent before use.";
        const string RejectedRecovery = "Correct the explicit profile/support/source or ownership conflict, then request a complete target import.";
        const string CleanupRecovery = "Do not use this attempt. Review native cleanup diagnostics, then perform a complete ownership-verified target import.";

        static readonly HashSet<string> generating = new HashSet<string>(StringComparer.Ordinal);
        static readonly Dictionary<string, CancellationTokenSource> cancellation = new Dictionary<string, CancellationTokenSource>(StringComparer.Ordinal);

        static ImportCompanion() {
            AssemblyReloadEvents.beforeAssemblyReload += CancelAll;
            EditorApplication.quitting += CancelAll;
        }

        static void CancelAll() {
            foreach (var token in cancellation.Values)
                token.Cancel();
        }

        internal static bool IsGenerating(string path) => generating.Contains(path);

        /// <summary>Owned output folder. A folder at this path is never adopted without the exact source GUID marker.</summary>
        public static string GetOutputDirectory(string sourcePath) =>
            Path.GetDirectoryName(sourcePath).Replace('\\', '/') + "/" + Path.GetFileNameWithoutExtension(sourcePath) + ".Margo";

        /// <summary>Generated prefab path; existence alone is not readiness.</summary>
        public static string GetPrefabPath(string sourcePath) => GetOutputDirectory(sourcePath) + "/" + Path.GetFileNameWithoutExtension(sourcePath) + ".prefab";

        /// <summary>Revalidates the actual executing support/profile/source tuple. Stored JSON alone is only a prior snapshot.</summary>
        public static bool IsCurrent(string sourcePath, out Report report) {
            report = null;
            try {
                var profile = ImportProfile.Read(sourcePath);
                var owner = CheckOwner(sourcePath, profile.sourceGuid);
                if (owner == null)
                    return false;
                report = ReadReport(sourcePath);
                if (!IsReadySnapshot(report, profile))
                    return false;
                RequireSourceIdentity(profile, owner);
                VerifyOutputs(sourcePath, owner, report.current);
                VerifySaved(profile, report.current.counts, owner);
                return true;
            } catch (Exception) { return false; }
        }

        /// <summary>A stored report that claims a complete generation of exactly this profile.</summary>
        static bool IsReadySnapshot(Report report, ImportProfile profile) {
            if (report == null || report.schema != 1 || report.profile != ImportProfile.Id || report.status != "ready" || !report.companionIsCurrent || report.error != null)
                return false;
            if (!Matches(report.current, profile) || !Matches(report.lastSuccessful, profile))
                return false;
            return Guid.TryParseExact(report.current.generationId, "N", out var generation) && generation != Guid.Empty &&
                JsonUtility.ToJson(report.lastSuccessful) == JsonUtility.ToJson(report.current);
        }

        /// <summary>Asynchronously imports one fixed, strictly validated asset through an isolated public glTFast invocation.</summary>
        public static async Task<bool> GenerateAsync(string sourcePath, CancellationToken cancellationToken = default) {
            if (!ImportProfile.IsSourcePath(sourcePath) || !generating.Add(sourcePath))
                return false;
            var run = new Generation(sourcePath, cancellationToken);
            cancellation.Add(sourcePath, run.linked);
            try {
                // Strict order: validate everything, import in isolation, write owned output, release
                // temporaries, then verify the saved result before the report may say ready.
                ValidateInputs(run);
                await ImportIsolatedAsync(run);
                var intendedOwner = PrepareOutputs(run);
                SaveOutputs(run, intendedOwner);
                ReleaseTemporaries(run);
                VerifyAndBind(run);
                return true;
            } catch (Exception error) {
                string code = error is OperationCanceledException ? "cancelled" : run.stage;
                Fail(run, code, error.Message, run.wrote ? PartialRecovery : RejectedRecovery);
                Debug.LogWarning("Margo strict target rejected " + sourcePath + " [" + code + "]: " + error.Message);
                return false;
            } finally {
                Finish(run);
            }
        }

        /// <summary>The mutable state of one <see cref="GenerateAsync"/> call, shared by its steps and its cleanup.</summary>
        sealed class Generation {
            internal readonly string sourcePath;
            internal readonly CancellationTokenSource linked;
            internal readonly CancellationToken token;
            internal readonly Prepared prepared = new Prepared();
            internal readonly Report report;
            internal ImportProfile profile;
            internal Owner owner;
            internal Tuple priorLastSuccessful;
            internal GltfImport importer;
            internal GameObject instance;
            internal bool wrote, reloadLocked, cleaned;
            internal string stage = "validation";

            internal Generation(string sourcePath, CancellationToken cancellationToken) {
                this.sourcePath = sourcePath;
                linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                token = linked.Token;
                report = new Report { status = "preparing", companionIsCurrent = false, current = Attempt(sourcePath) };
            }
        }

        /// <summary>Step 1: invalidates any owned snapshot, then reads the profile and checks ownership, history and the existing clock.</summary>
        static void ValidateInputs(Generation run) {
            var previous = ReadReport(run.sourcePath);
            run.priorLastSuccessful = previous?.lastSuccessful ?? (previous != null && previous.status == "ready" ? previous.current : null);
            run.report.lastSuccessful = run.priorLastSuccessful;
            // Invalidate an already-owned snapshot before asynchronous work; fresh/unowned folders receive no write.
            MarkNotCurrent(run.sourcePath, "preparing", "Input import or explicit target generation requested.", false);
            run.token.ThrowIfCancellationRequested();
            run.profile = ImportProfile.Read(run.sourcePath);
            run.report.current = Attempt(run.profile);
            run.owner = CheckOwner(run.sourcePath, run.profile.sourceGuid);
            ValidateHistory(run.profile, run.owner, previous);
            ValidateExistingClock(run.profile, run.owner);
        }

        /// <summary>Step 2: imports the GLB into a hidden, unsaved instance under one balanced assembly-reload lock.</summary>
        static async Task ImportIsolatedAsync(Generation run) {
            run.instance = new GameObject("model");
            run.instance.SetActive(false);
            run.instance.hideFlags = HideFlags.HideAndDontSave;
            var logger = new CollectingLogger();
            run.importer = new GltfImport(deferAgent: new UninterruptedDeferAgent(), logger: logger);
            // A reload cannot discard this asynchronous attempt before Finish releases
            // native resources. This owns exactly one balanced reload lock.
            EditorApplication.LockReloadAssemblies();
            run.reloadLocked = true;
            await LoadIsolatedAsync(run.profile, run.importer, logger, run.instance, run.token);
        }

        /// <summary>Step 3: checks the imported graph, makes owned copies and returns the owner identity to write; nothing is written yet.</summary>
        static Owner PrepareOutputs(Generation run) {
            var profile = run.profile;
            ValidateGraph(profile, run.importer, run.instance);
            PreserveOverrides(run.instance, AssetDatabase.LoadAssetAtPath<GameObject>(GetPrefabPath(run.sourcePath)));
            Prepare(profile, run.importer, run.instance, run.prepared, run.report.current.counts);
            ValidateImportedAnimator(run.instance, run.prepared.clips.Length);
            var nextMeshes = MeshIdentities(profile, run.instance);
            ValidateUpdateIdentity(profile, run.owner, nextMeshes);
            ValidateOutputNames(run.sourcePath, run.owner, run.prepared, run.report.current.counts.clips > 0);
            // Recheck native graph edits after await; never silently reset them.
            ValidateExistingClock(profile, run.owner);
            var intendedOwner = run.owner ?? CreateOwnerIdentity(profile, nextMeshes);
            run.report.current.identityManifestSHA256 = IdentityHash(intendedOwner);
            profile.AssertInputsCurrent();
            run.token.ThrowIfCancellationRequested();
            return intendedOwner;
        }

        /// <summary>Step 4: establishes ownership, then saves the resources and the prefab; from here a failure is partial output.</summary>
        static void SaveOutputs(Generation run, Owner intendedOwner) {
            run.stage = "owned-output";
            run.wrote = true;
            run.owner = EstablishOwner(run.profile, intendedOwner, run.owner != null);
            WriteReport(run.sourcePath, run.report);
            run.stage = "resources";
            SaveResources(run.profile, run.instance, run.prepared, run.owner);
            run.token.ThrowIfCancellationRequested();
            run.stage = "prefab";
            run.instance.hideFlags = HideFlags.None;
            run.instance.SetActive(true);
            string prefab = GetPrefabPath(run.sourcePath);
            if (PrefabUtility.SaveAsPrefabAsset(run.instance, prefab) == null)
                throw new IOException("Unity did not save the generated prefab; check the console and import again.");
            Record(run.owner, run.sourcePath, prefab, typeof(GameObject));
            FlushOwned(run.sourcePath, run.owner);
        }

        /// <summary>Step 5: destroys the temporary instance, copies and importer before the saved assets are verified.</summary>
        static void ReleaseTemporaries(Generation run) {
            run.stage = "temporary-cleanup";
            var instance = run.instance;
            var importer = run.importer;
            run.instance = null;
            run.importer = null;
            Cleanup(instance, run.prepared, importer);
            run.cleaned = true;
        }

        /// <summary>Step 6: reverifies inputs and the saved prefab, binds the output hashes and writes the ready report.</summary>
        static void VerifyAndBind(Generation run) {
            run.stage = "post-save-verification";
            run.profile.AssertInputsCurrent();
            VerifySaved(run.profile, run.report.current.counts, run.owner);
            run.token.ThrowIfCancellationRequested();
            BindOutputs(run.sourcePath, run.owner, run.report.current);
            run.report.status = "ready";
            run.report.companionIsCurrent = true;
            run.report.error = null;
            run.report.lastSuccessful = run.report.current;
            WriteReport(run.sourcePath, run.report);
        }

        /// <summary>Always runs: releases temporaries a failed attempt left, ends the run and releases the reload lock last.</summary>
        static void Finish(Generation run) {
            try {
                if (!run.cleaned)
                    try {
                        Cleanup(run.instance, run.prepared, run.importer);
                    } catch (Exception error) {
                        Fail(run, "temporary-cleanup", error.Message, CleanupRecovery);
                        Debug.LogWarning("Margo strict target cleanup failed for " + run.sourcePath + ": " + error.Message);
                    }
            } finally {
                try {
                    run.linked.Dispose();
                    cancellation.Remove(run.sourcePath);
                    generating.Remove(run.sourcePath);
                } finally {
                    if (run.reloadLocked)
                        EditorApplication.UnlockReloadAssemblies();
                }
            }
        }

        /// <summary>Loads the validated GLB bytes and instantiates the default scene under <paramref name="instance"/>, rejecting any glTFast error.</summary>
        static async Task LoadIsolatedAsync(ImportProfile profile, GltfImport importer, CollectingLogger logger, GameObject instance, CancellationToken token) {
            new NodeAddon(profile).Inject(importer);
            var settings = new ImportSettings {
                NodeNameMethod = NameImportMethod.OriginalUnique,
                AnimationMethod = AnimationMethod.Mecanim,
                GenerateMipMaps = false,
                TexturesReadable = true,
                AnisotropicFilterLevel = 0,
            };
            if (!await importer.Load(profile.glb.bytes, new Uri(Path.GetFullPath(profile.sourcePath)), settings, token))
                throw new InvalidDataException("Public glTFast target load failed.");
            token.ThrowIfCancellationRequested();
            ImportProfile.Require(importer.SceneCount == 1 && importer.DefaultSceneIndex == 0, "Public target source has no exact declared default scene.");
            var instantiator = new GameObjectInstantiator(importer, instance.transform, logger, new InstantiationSettings { SceneObjectCreation = SceneObjectCreation.Never });
            if (!await importer.InstantiateSceneAsync(instantiator, 0, token))
                throw new InvalidDataException("Public glTFast target instantiation failed.");
            if (logger.Items != null && logger.Items.Any(item => item.Type == LogType.Error || item.Type == LogType.Exception)) {
                logger.LogAll();
                throw new InvalidDataException("Public glTFast target reported an import error.");
            }
            token.ThrowIfCancellationRequested();
        }

        /// <summary>Marks the run's report failed, restores the prior last success and writes it when the folder is owned.</summary>
        static void Fail(Generation run, string code, string message, string recovery) {
            var report = run.report;
            report.status = run.wrote ? "stale" : "rejected";
            report.companionIsCurrent = false;
            report.lastSuccessful = run.priorLastSuccessful;
            report.error = new Error { code = code, message = message, partialOutput = run.wrote, recovery = recovery };
            TryWriteOwnedReport(run.sourcePath, report);
        }

        static void Cleanup(GameObject instance, Prepared prepared, GltfImport importer) {
            Exception failure = null;
            try {
                if (instance != null)
                    Object.DestroyImmediate(instance);
            } catch (Exception e) { failure = e; }
            try {
                prepared.Destroy();
            } catch (Exception e) { failure = failure ?? e; }
            try {
                importer?.Dispose();
            } catch (Exception e) { failure = failure ?? e; }
            if (failure != null)
                throw new InvalidOperationException("Controlled public target cleanup failed.", failure);
        }

        /// <summary>Cancels a running generation and marks an owned snapshot not current after an input changed.</summary>
        internal static void MarkNotCurrent(string path, string status, string message, bool cancel = true) {
            if (!ImportProfile.IsSourcePath(path))
                return;
            if (cancel && cancellation.TryGetValue(path, out var token))
                token.Cancel();
            var previous = ReadReport(path);
            if (previous == null)
                return;
            previous.lastSuccessful = previous.lastSuccessful ?? (previous.companionIsCurrent ? previous.current : null);
            previous.current = Attempt(path);
            previous.status = status;
            previous.companionIsCurrent = false;
            previous.error = new Error { code = "input-changed", message = message, partialOutput = false, recovery = "A complete valid target import and fresh IsCurrent check are required." };
            TryWriteOwnedReport(path, previous);
        }
    }
}
