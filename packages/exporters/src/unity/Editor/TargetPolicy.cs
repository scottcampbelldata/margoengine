using System;
using System.Globalization;
using System.Linq;
using System.Text;

namespace MargoMesh.Unity.Editor {
    /// <summary>
    /// Pure owned-identity and animation-clock contract. Native Unity/glTFast still own all object, mesh, curve, skin and
    /// animation evaluation.
    /// </summary>
    internal static class TargetPolicy {
        internal const int OwnerSchema = 2;
        internal const string ControllerPolicy = "margo-unity-source-clock-v1";

        [Serializable]
        internal sealed class ClipIdentity {
            public int animationIndex;
            public string name;
        }

        [Serializable]
        internal sealed class MeshIdentity {
            public string path;
            public int meshIndex, meshNumeration;
            public string[] sourceIds;
        }

        [Serializable]
        internal sealed class FileIdentity {
            public string path, type;
        }

        /// <summary>The clock-relevant settings of one Animator state.</summary>
        internal sealed class State {
            public string name, speedParameter, cycleOffsetParameter, mirrorParameter, timeParameter, tag;
            public float speed, cycleOffset;
            public bool motionOwned, mirror, iKOnFeet, writeDefaultValues;
            public bool speedParameterActive, cycleOffsetParameterActive, mirrorParameterActive, timeParameterActive;
            public int transitions, behaviours;
        }

        /// <summary>The clock-relevant settings of the root Animator and its controller.</summary>
        internal sealed class Clock {
            public int animatorCount, layers, parameters, syncedLayerIndex;
            public int childMachines, anyTransitions, entryTransitions, machineTransitions, machineBehaviours, unlistedSubAssets, defaultStateIndex;
            public bool animatorAtRoot, animatorEnabled, animatorController, avatarNull, normalUpdate, rootMotion, alwaysAnimate;
            public bool overrideLayer, maskNull, syncedTiming, iKPass;
            public string controllerName, layerName, stateMachineName;
            public float animatorSpeed, layerWeight;
            public State[] states;
        }

        static void Require(bool value, string message) => ImportProfile.Require(value, message);
        static string Encode(string value) {
            Require(value != null, "Identity text is missing.");
            return Convert.ToBase64String(new UTF8Encoding(false, true).GetBytes(value));
        }
        static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);

        /// <summary>Canonical text of the ordered clip names and mesh-file/source-id mapping; validates both on the way.</summary>
        internal static string CanonicalIdentity(string policy, ClipIdentity[] clips, MeshIdentity[] meshes) {
            Require(policy == ControllerPolicy && clips != null && meshes != null, "Unsupported or missing owned identity policy. Use a fresh target.");
            var result = new StringBuilder("margo-owner-identity-v2\npolicy\t").Append(Encode(policy)).Append('\n');
            Require(clips.Select(c => c?.name).Distinct(StringComparer.Ordinal).Count() == clips.Length, "Duplicate/missing ordered clip identities.");
            for (int i = 0; i < clips.Length; i++) {
                var clip = clips[i];
                Require(clip != null && clip.animationIndex == i && !string.IsNullOrEmpty(clip.name), "Invalid ordered clip identity.");
                result.Append("clip\t").Append(Number(i)).Append('\t').Append(Encode(clip.name)).Append('\n');
            }
            string previous = null;
            foreach (var mesh in meshes) {
                Require(IsMeshFile(mesh) && (previous == null || string.CompareOrdinal(previous, mesh.path) < 0), "Invalid/unsorted/duplicate mesh-file identity.");
                Require(IsSortedIdSet(mesh.sourceIds), "Mesh identities require the complete sorted unique source-ID set.");
                previous = mesh.path;
                result.Append("mesh\t").Append(Encode(mesh.path)).Append('\t').Append(Number(mesh.meshIndex)).Append('\t')
                    .Append(Number(mesh.meshNumeration)).Append('\t').Append(Number(mesh.sourceIds.Length));
                foreach (string id in mesh.sourceIds)
                    result.Append('\t').Append(Encode(id));
                result.Append('\n');
            }
            return result.ToString();
        }

        static bool IsMeshFile(MeshIdentity mesh) =>
            mesh != null && mesh.meshIndex >= 0 && mesh.meshNumeration >= 0 &&
            mesh.path == "Mesh_" + Number(mesh.meshIndex) + "_" + Number(mesh.meshNumeration) + ".asset";

        static bool IsSortedIdSet(string[] ids) =>
            ids != null && ids.Length > 0 && ids.All(id => !string.IsNullOrEmpty(id)) &&
            ids.SequenceEqual(ids.Distinct(StringComparer.Ordinal).OrderBy(id => id, StringComparer.Ordinal));

        internal static void SameIdentity(string policy, ClipIdentity[] previousClips, MeshIdentity[] previousMeshes, ClipIdentity[] nextClips, MeshIdentity[] nextMeshes) {
            Require(CanonicalIdentity(policy, previousClips, previousMeshes) == CanonicalIdentity(ControllerPolicy, nextClips, nextMeshes),
                "Ordered clip names or source-ID/mesh-file mapping changed. Use a fresh target; no GUID is retargeted and no asset is deleted.");
        }

        internal static void SameClips(ClipIdentity[] previous, ClipIdentity[] next) {
            var noMeshes = Array.Empty<MeshIdentity>();
            Require(CanonicalIdentity(ControllerPolicy, previous, noMeshes) == CanonicalIdentity(ControllerPolicy, next, noMeshes),
                "Ordered clip names changed. Rename/reorder/add/remove/zero transitions require a fresh target.");
        }

        internal static string CanonicalFiles(FileIdentity[] files) {
            Files(files, files, false);
            return "files-v1\n" + string.Concat(files.OrderBy(f => f.path, StringComparer.Ordinal).Select(f => Encode(f.path) + "\t" + Encode(f.type) + "\n"));
        }

        /// <summary>Every <paramref name="actual"/> file is an expected one; unless <paramref name="recordedPartial"/>, none is missing.</summary>
        internal static void Files(FileIdentity[] actual, FileIdentity[] expected, bool recordedPartial) {
            bool Complete(FileIdentity[] files) => files != null && files.All(f => f != null && !string.IsNullOrEmpty(f.path) && !string.IsNullOrEmpty(f.type));
            bool Unique(FileIdentity[] files) => files.Select(f => f.path).Distinct(StringComparer.Ordinal).Count() == files.Length;
            Require(Complete(actual) && Complete(expected), "Missing intended owned file inventory.");
            Require(Unique(actual) && Unique(expected), "Duplicate intended/recorded file inventory.");
            Require(actual.All(f => expected.Count(e => e.path == f.path && e.type == f.type) == 1) && (recordedPartial || actual.Length == expected.Length),
                "Surplus, missing or reassigned owned files require a fresh target or explicit conflict review; nothing is deleted/adopted.");
        }

        /// <summary>A static target has no Animator; an animated one has exactly the source-clock Animator and controller.</summary>
        internal static void ValidateClock(Clock c, ClipIdentity[] clips) {
            SameClips(clips, clips);
            Require(c != null, "Missing native clock snapshot.");
            if (clips.Length == 0) {
                Require(c.animatorCount == 0, "Static target contains an undeclared Animator.");
                return;
            }
            bool sourceClock = c.animatorCount == 1 && c.animatorAtRoot && c.animatorEnabled && c.animatorController && c.avatarNull &&
                c.animatorSpeed == 1 && c.normalUpdate && !c.rootMotion && c.alwaysAnimate;
            Require(sourceClock, "Unsupported Animator enabled/clock/root/controller edit. Restore the source-clock profile or use a fresh target.");
            ValidateController(c, clips);
        }

        internal static void ValidateStoredRoot(bool activeSelf) {
            Require(activeSelf, "Stored target prefab root is inactive. Restore activeSelf=true or use a fresh target; runtime instance activation is not constrained.");
        }

        /// <summary>One override layer, no parameters or extra graph, and one untouched state per clip in source order.</summary>
        internal static void ValidateController(Clock c, ClipIdentity[] clips) {
            SameClips(clips, clips);
            Require(c != null && clips.Length > 0, "Missing animated controller snapshot.");
            bool layer = c.controllerName == "model" && c.stateMachineName == "Base Layer" && c.layers == 1 && c.parameters == 0 && c.layerName == "Base Layer" &&
                c.overrideLayer && c.layerWeight == 1 && c.maskNull && c.syncedLayerIndex == -1 && !c.syncedTiming && !c.iKPass;
            Require(layer, "Unsupported controller layer/parameter edit.");
            bool graph = c.childMachines == 0 && c.anyTransitions == 0 && c.entryTransitions == 0 && c.machineTransitions == 0 && c.machineBehaviours == 0 &&
                c.unlistedSubAssets == 0 && c.defaultStateIndex == 0 && c.states != null && c.states.Length == clips.Length;
            Require(graph, "Unsupported controller graph/default-state edit.");
            for (int i = 0; i < clips.Length; i++)
                Require(IsSourceState(c.states[i], clips[i].name), "Unsupported native state clock/motion/transition edit at source clip " + Number(i) + ".");
        }

        static bool IsSourceState(State s, string name) {
            if (s == null || s.name != name || !s.motionOwned)
                return false;
            bool clock = s.speed == 1 && s.cycleOffset == 0 && !s.mirror && !s.iKOnFeet && s.writeDefaultValues;
            bool noParameters = !s.speedParameterActive && !s.cycleOffsetParameterActive && !s.mirrorParameterActive && !s.timeParameterActive &&
                string.IsNullOrEmpty(s.speedParameter) && string.IsNullOrEmpty(s.cycleOffsetParameter) && string.IsNullOrEmpty(s.mirrorParameter) &&
                string.IsNullOrEmpty(s.timeParameter) && string.IsNullOrEmpty(s.tag);
            return clock && noParameters && s.transitions == 0 && s.behaviours == 0;
        }
    }
}
