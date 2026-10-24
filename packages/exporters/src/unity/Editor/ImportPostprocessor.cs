using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace MargoMesh.Unity.Editor {
    /// <summary>Queues a target import when a fixed <c>model.glb</c>, <c>atlas.png</c> or <c>margo-profile.json</c> changes. No global add-on, startup scan or raw reimport.</summary>
    sealed class ImportPostprocessor : AssetPostprocessor {
        static readonly HashSet<string> pending = new HashSet<string>(StringComparer.Ordinal);
        static bool scheduled, processing;
        /// <summary>The fixed model.glb whose bundle contains <paramref name="path"/>, or null.</summary>
        static string SourceFor(string path) {
            if (string.IsNullOrEmpty(path))
                return null;
            string name = Path.GetFileName(path);
            if (name != "model.glb" && name != "atlas.png" && name != "margo-profile.json")
                return null;
            string source = Path.GetDirectoryName(path).Replace('\\', '/') + "/model.glb";
            return ImportProfile.IsSourcePath(source) ? source : null;
        }
        static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom, bool didDomainReload) {
            var changed = new HashSet<string>(StringComparer.Ordinal);
            foreach (var list in new[] { imported, deleted, moved, movedFrom })
                foreach (string path in list) {
                    string source = SourceFor(path);
                    if (source != null)
                        changed.Add(source);
                }
            foreach (string source in changed) {
                bool opted = File.Exists(ImportProfile.ProfilePath(source));
                // Only an already-owned snapshot may be changed on deletion/no-sidecar.
                ImportCompanion.MarkNotCurrent(source, "stale", "A fixed source/profile/atlas sibling was imported, moved or deleted.");
                if (opted && File.Exists(source))
                    pending.Add(source);
            }
            Schedule();
        }
        static void Schedule() {
            if (scheduled || processing || pending.Count == 0)
                return;
            scheduled = true;
            EditorApplication.delayCall += Process;
        }
        /// <summary>Imports each pending source that is not current, one at a time, outside compilation and asset updates.</summary>
        static async void Process() {
            scheduled = false;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) {
                Schedule();
                return;
            }
            processing = true;
            try {
                while (pending.Count > 0) {
                    var work = new List<string>(pending);
                    work.Sort(StringComparer.Ordinal);
                    pending.Clear();
                    foreach (string source in work) {
                        if (!File.Exists(source) || !File.Exists(ImportProfile.ProfilePath(source)))
                            continue;
                        if (ImportCompanion.IsGenerating(source)) {
                            pending.Add(source);
                            continue;
                        }
                        if (!ImportCompanion.IsCurrent(source, out _))
                            await ImportCompanion.GenerateAsync(source);
                    }
                    if (pending.Count > 0)
                        break;
                    await Task.Yield();
                    if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                        break;
                }
            } catch (Exception e) {
                Debug.LogWarning("Margo strict target queue failed: " + e.Message);
            } finally {
                processing = false;
                Schedule();
            }
        }
    }
}
