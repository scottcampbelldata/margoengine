using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using Object = UnityEngine.Object;

namespace MargoMesh.Unity.Editor {
    // The owned Animator controller and its source-clock snapshot.
    public static partial class ImportCompanion {
        /// <summary>The prefab's Animator settings plus its controller graph, for <see cref="TargetPolicy.ValidateClock"/>.</summary>
        static TargetPolicy.Clock ClockSnapshot(GameObject prefab, AnimatorController controller, AnimationClip[] clips) {
            var animators = prefab.GetComponentsInChildren<Animator>(true);
            if (clips.Length == 0)
                return new TargetPolicy.Clock { animatorCount = animators.Length };
            ImportProfile.Require(animators.Length == 1 && controller != null, "Exact owned Animator/controller is missing; import the asset again.");
            var animator = animators[0];
            var c = ControllerSnapshot(controller, clips);
            c.animatorCount = animators.Length;
            c.animatorAtRoot = animator.gameObject == prefab;
            c.animatorEnabled = animator.enabled;
            c.animatorController = animator.runtimeAnimatorController == controller;
            c.avatarNull = animator.avatar == null;
            c.animatorSpeed = animator.speed;
            c.normalUpdate = animator.updateMode == AnimatorUpdateMode.Normal;
            c.rootMotion = animator.applyRootMotion;
            c.alwaysAnimate = animator.cullingMode == AnimatorCullingMode.AlwaysAnimate;
            return c;
        }

        /// <summary>The controller's layer, state-machine and state settings, for <see cref="TargetPolicy.ValidateController"/>.</summary>
        static TargetPolicy.Clock ControllerSnapshot(AnimatorController controller, AnimationClip[] clips) {
            ImportProfile.Require(controller != null, "Owned controller is missing; import the asset again.");
            var layers = controller.layers;
            ImportProfile.Require(layers.Length == 1 && layers[0].stateMachine != null, "Unsupported owned controller layer graph; use a fresh target.");
            var layer = layers[0];
            var machine = layer.stateMachine;
            var states = machine.states;
            var c = new TargetPolicy.Clock {
                layers = layers.Length,
                parameters = controller.parameters.Length,
                controllerName = controller.name,
                stateMachineName = machine.name,
                layerName = layer.name,
                overrideLayer = layer.blendingMode == AnimatorLayerBlendingMode.Override,
                layerWeight = layer.defaultWeight,
                maskNull = layer.avatarMask == null,
                syncedLayerIndex = layer.syncedLayerIndex,
                syncedTiming = layer.syncedLayerAffectsTiming,
                iKPass = layer.iKPass,
                childMachines = machine.stateMachines.Length,
                anyTransitions = machine.anyStateTransitions.Length,
                entryTransitions = machine.entryTransitions.Length,
                machineTransitions = machine.GetStateMachineTransitions(machine).Length,
                machineBehaviours = machine.behaviours.Length,
                defaultStateIndex = Array.FindIndex(states, s => s.state == machine.defaultState),
            };
            var expected = new HashSet<Object> { controller, machine };
            foreach (var s in states) {
                ImportProfile.Require(s.state != null, "Owned controller has a missing state; use a fresh target.");
                expected.Add(s.state);
            }
            var assets = AssetDatabase.LoadAllAssetsAtPath(AssetDatabase.GetAssetPath(controller));
            c.unlistedSubAssets = assets.Count(a => a != null && !expected.Contains(a)) + expected.Count(a => !assets.Contains(a));
            c.states = states.Select((s, i) => StateSnapshot(controller, s.state, i < clips.Length ? clips[i] : null)).ToArray();
            return c;
        }

        static TargetPolicy.State StateSnapshot(AnimatorController controller, AnimatorState state, AnimationClip clip) => new TargetPolicy.State {
            name = state.name,
            motionOwned = clip != null && state.motion == clip && controller.GetStateEffectiveMotion(state, 0) == clip,
            speed = state.speed,
            cycleOffset = state.cycleOffset,
            mirror = state.mirror,
            iKOnFeet = state.iKOnFeet,
            writeDefaultValues = state.writeDefaultValues,
            speedParameterActive = state.speedParameterActive,
            cycleOffsetParameterActive = state.cycleOffsetParameterActive,
            mirrorParameterActive = state.mirrorParameterActive,
            timeParameterActive = state.timeParameterActive,
            speedParameter = state.speedParameter,
            cycleOffsetParameter = state.cycleOffsetParameter,
            mirrorParameter = state.mirrorParameter,
            timeParameter = state.timeParameter,
            tag = state.tag,
            transitions = state.transitions.Length,
            behaviours = state.behaviours.Length + (controller.GetStateEffectiveBehaviours(state, 0)?.Length ?? 0),
        };

        /// <summary>glTFast may add at most one Animator, on the root, and none for a static asset.</summary>
        static void ValidateImportedAnimator(GameObject instance, int clips) {
            var animators = instance.GetComponentsInChildren<Animator>(true);
            bool supported = clips == 0 ? animators.Length == 0 : animators.Length <= 1 && (animators.Length == 0 || animators[0].gameObject == instance);
            ImportProfile.Require(supported, "Imported Animator path/inventory is unsupported; it is never silently moved or removed.");
        }

        static AnimatorController OwnedController(ImportProfile profile, Owner owner) {
            string name = ControllerFile(profile.sourcePath);
            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(OutputPath(profile.sourcePath, name));
            RequireOwned(controller, profile.sourcePath, owner, name, typeof(AnimatorController));
            return controller;
        }

        /// <summary>Rejects hand edits to an existing target's Animator clock before they could be overwritten.</summary>
        static void ValidateExistingClock(ImportProfile profile, Owner owner) {
            if (owner == null)
                return;
            string source = profile.sourcePath;
            int clipCount = profile.data.clips.Length;
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(GetPrefabPath(source));
            if (prefab == null) {
                // A partial earlier attempt may have saved the controller and clips before the prefab.
                ImportProfile.Require(!owner.files.Any(f => f.path == PrefabFile(source)), "Recorded prefab is missing; restore it or use a fresh target.");
                if (clipCount > 0 && owner.files.Any(f => f.path == ControllerFile(source))) {
                    var controller = OwnedController(profile, owner);
                    var clips = Enumerable.Range(0, clipCount).Select(i => AssetDatabase.LoadAssetAtPath<AnimationClip>(OutputPath(source, ClipFile(i)))).ToArray();
                    for (int i = 0; i < clips.Length; i++)
                        RequireOwned(clips[i], source, owner, ClipFile(i), typeof(AnimationClip));
                    TargetPolicy.ValidateController(ControllerSnapshot(controller, clips), owner.clipIdentities);
                }
                return;
            }
            TargetPolicy.ValidateStoredRoot(prefab.activeSelf);
            var resources = prefab.GetComponent<ImportIndex>();
            ImportProfile.Require(resources != null && resources.clips != null && resources.clips.Length == clipCount, "Existing owned clip list changed. Use a fresh target.");
            for (int i = 0; i < resources.clips.Length; i++)
                RequireOwned(resources.clips[i], source, owner, ClipFile(i), typeof(AnimationClip));
            var exact = resources.clips.Length > 0 ? OwnedController(profile, owner) : null;
            TargetPolicy.ValidateClock(ClockSnapshot(prefab, exact, resources.clips), owner.clipIdentities);
        }

        /// <summary>Creates or updates the owned controller (one state per clip, source clock) and binds it to the root Animator.</summary>
        static void WireController(GameObject instance, AnimationClip[] clips, string source, Owner owner) {
            string path = OutputPath(source, ControllerFile(source));
            var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);
            bool fresh = controller == null;
            if (fresh)
                controller = CreateController(path);
            Record(owner, source, path, typeof(AnimatorController));
            var machine = controller.layers[0].stateMachine;
            var existing = machine.states;
            ImportProfile.Require(fresh ? existing.Length == 0 : existing.Length == clips.Length, "Existing state inventory changed; no state is removed or adopted.");
            for (int i = 0; i < clips.Length; i++) {
                var state = fresh ? CreateState(machine, clips[i], i) : existing[i].state;
                ImportProfile.Require(state.name == owner.clipIdentities[i].name, "Owned state identity changed; no state GUID is retargeted.");
                state.motion = clips[i];
                EditorUtility.SetDirty(state);
            }
            if (fresh)
                machine.defaultState = machine.states[0].state;
            EditorUtility.SetDirty(machine);
            EditorUtility.SetDirty(controller);
            ValidateImportedAnimator(instance, clips.Length);
            // Unity overloads null for destroyed/missing objects, so test the array rather than using ??.
            var animators = instance.GetComponentsInChildren<Animator>(true);
            var animator = animators.Length == 0 ? instance.AddComponent<Animator>() : animators[0];
            animator.runtimeAnimatorController = controller;
            animator.enabled = true;
            animator.avatar = null;
            animator.speed = 1;
            animator.updateMode = AnimatorUpdateMode.Normal;
            animator.applyRootMotion = false;
            animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            TargetPolicy.ValidateClock(ClockSnapshot(instance, controller, clips), owner.clipIdentities);
        }

        static AnimatorController CreateController(string path) {
            var controller = AnimatorController.CreateAnimatorControllerAtPath(path);
            controller.name = "model";
            controller.parameters = Array.Empty<AnimatorControllerParameter>();
            var layers = controller.layers;
            ImportProfile.Require(layers.Length == 1, "Native new controller has unsupported layer inventory.");
            var layer = layers[0];
            layer.name = "Base Layer";
            layer.blendingMode = AnimatorLayerBlendingMode.Override;
            layer.defaultWeight = 1;
            layer.avatarMask = null;
            layer.syncedLayerIndex = -1;
            layer.syncedLayerAffectsTiming = false;
            layer.iKPass = false;
            controller.layers = layers;
            layer.stateMachine.name = "Base Layer";
            return controller;
        }

        static AnimatorState CreateState(AnimatorStateMachine machine, AnimationClip clip, int index) {
            var state = machine.AddState(clip.name, new Vector3(250, 50 + index * 65, 0));
            state.name = clip.name;
            state.speed = 1;
            state.cycleOffset = 0;
            state.mirror = false;
            state.iKOnFeet = false;
            state.writeDefaultValues = true;
            state.speedParameterActive = false;
            state.cycleOffsetParameterActive = false;
            state.mirrorParameterActive = false;
            state.timeParameterActive = false;
            state.speedParameter = "";
            state.cycleOffsetParameter = "";
            state.mirrorParameter = "";
            state.timeParameter = "";
            state.tag = "";
            return state;
        }
    }
}
