using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;

// Batch-mode check run by packages/exporters/scripts/test-unity.mjs (npm run test:unity). It waits for the companion
// to generate Assets/Margo/Ranger, writes each saved asset's main object name, file name and file hashes, forces a
// reimport of every generated file and writes them again, then exits. The Node script reads the result and decides.
namespace MargoCheck {
    public static class NameCheck {
        const string Source = "Assets/Margo/Ranger/model.glb";
        const double GenerateLimitSeconds = 300;
        static double start;
        static int phase;
        static string resultPath;
        static readonly StringBuilder log = new StringBuilder();

        public static void Run() {
            var args = Environment.GetCommandLineArgs();
            int at = Array.IndexOf(args, "-margoResult");
            resultPath = at >= 0 && at + 1 < args.Length ? args[at + 1] : "margo-unity-check.txt";
            start = EditorApplication.timeSinceStartup;
            Application.logMessageReceived += (message, trace, type) => {
                if (message.IndexOf("does not match filename", StringComparison.OrdinalIgnoreCase) >= 0)
                    log.AppendLine("WARNING\t" + message.Replace("\n", " ").Replace("\t", " "));
            };
            EditorApplication.update += Tick;
        }

        static string Sha(string path) {
            using (var sha = SHA256.Create())
                return File.Exists(path) ? BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(path))).Replace("-", "") : "missing";
        }

        static void Names(string label) {
            string dir = MargoMesh.Unity.Editor.ImportCompanion.GetOutputDirectory(Source);
            foreach (var path in AssetDatabase.FindAssets("", new[] { dir }).Select(AssetDatabase.GUIDToAssetPath).Distinct().OrderBy(p => p, StringComparer.Ordinal)) {
                var main = AssetDatabase.LoadMainAssetAtPath(path);
                if (main == null || main is DefaultAsset) continue;
                log.AppendLine(string.Join("\t", "ASSET", label, path, main.GetType().Name, main.name, Path.GetFileNameWithoutExtension(path), Sha(path), Sha(path + ".meta")));
                var controller = main as UnityEditor.Animations.AnimatorController;
                if (controller != null)
                    foreach (var state in controller.layers[0].stateMachine.states)
                        log.AppendLine(string.Join("\t", "STATE", label, state.state.name, state.state.motion != null ? state.state.motion.name : "none"));
            }
        }

        static void Finish() {
            File.WriteAllText(resultPath, log.ToString());
            EditorApplication.update -= Tick;
            EditorApplication.Exit(0);
        }

        static void Tick() {
            double t = EditorApplication.timeSinceStartup - start;
            MargoMesh.Unity.Editor.ImportCompanion.Report report;
            bool current = MargoMesh.Unity.Editor.ImportCompanion.IsCurrent(Source, out report);
            if (phase == 0 && (current || t > GenerateLimitSeconds)) {
                log.AppendLine("CURRENT\tBEFORE\t" + current + "\t" + t.ToString("F1") + "\t" + (report != null && report.error != null ? JsonUtility.ToJson(report.error) : "none"));
                if (!current) {
                    Finish();
                    return;
                }
                Names("BEFORE");
                string dir = MargoMesh.Unity.Editor.ImportCompanion.GetOutputDirectory(Source);
                foreach (var path in AssetDatabase.FindAssets("", new[] { dir }).Select(AssetDatabase.GUIDToAssetPath).Distinct())
                    AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
                phase = 1;
                start = EditorApplication.timeSinceStartup;
                return;
            }
            if (phase == 1 && t > 5) {
                Names("AFTER");
                log.AppendLine("CURRENT\tAFTER\t" + MargoMesh.Unity.Editor.ImportCompanion.IsCurrent(Source, out report));
                Finish();
            }
        }
    }
}
