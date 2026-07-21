# Spatial attachments

PetPlay spatial UI uses two separate concepts:

- A **GrabBox** is the only object that may initiate a spatial grab. Its hull must closely match the
  element it represents; attachment groups never add an interaction hull.
- An **attachment group** is a transform-only R3F group. It carries a primary element and its
  attached children, but cannot be grabbed directly.

The runtime source of truth is a normalized spatial graph, not a fixed JSX hierarchy. Displays,
controls, and future spatial tools are generic nodes with generated IDs. Each node has one parent
element or one origin, a local transform, its own GrabBox policy, and optionally a constraint on its
attachment edge. R3F recursively projects that graph into groups and Handles.

The primary element's Handle uses its own GrabBox as `handleRef` and the attachment group as
`targetRef`. Moving, rotating, or two-hand scaling the primary therefore transforms the complete
assembly around the primary's pivot. Empty space between children remains non-interactive.

Attached children retain local transforms and accurate GrabBoxes. Their normal Handle changes their
pose relative to the attachment group. Detaching a child will later reparent it to an origin while
preserving its world transform (`newLocal = inverse(newParentWorld) * oldWorld`).

Parenting and constraints are independent. A monitor can therefore be hinge-constrained beneath
another monitor, freely posed beneath it, or detached beneath an origin. Releasing a constraint
flattens its evaluated pose into the child's local transform. Detaching evaluates its world pose and
reparents it to the selected origin. Neither transition may visibly move the element.

Hinges also support physical breakaway during their normal grab. The Handle records the initial
grabber-to-hinge distance and releases the constraint when that distance grows beyond an input-mode
slack threshold. VR uses a short physical controller pull (`0.22m`). Desktop uses the raw cursor's
radial screen-space distance from the projected hinge (`180px`) because Handle's 3D mouse point is
already projected onto the constraint and cannot represent an outward pull. Breakaway removes only
the constraint, so the child remains parented and its evaluated hinge pose becomes its free local
pose.

The rendered attachment target and HandleStore remain mounted across physical breakaway. After the
hinge transform is flattened, the active store calls `save()` to rebase its target and pointer data
without releasing pointer capture. This hands the same grab from constrained rotation to ordinary
free-parented manipulation; an immediate pointer-up is guarded from replaying the stale hinge output
state. Before rebasing, the free target translates so the constrained grab point meets the raw
pointer: desktop unprojects the cursor at the grab point's depth, while VR uses the controller world
position. This removes the spatial gap accumulated while pulling away from the hinge.

Visual content beneath a spatial element must deny the `grab` pointer type. Spatial controls such as
buttons are their own GrabBox-backed elements, with logical attachment metadata rather than being
physically nested inside another element's GrabBox. Their normal grab interaction may be disabled
until low-level edit mode exposes it.

## Snap hitboxes

Snapping composes two generic capabilities. A movable spatial node advertises a snap-source shape,
normally matching its GrabBox bounds. Another node owns one or more snap-target hitboxes containing
a shape, accepted node kinds, and an attachment recipe. Hitbox overlap only selects a compatible
target; it does not contain keyboard-, monitor-, or application-specific behavior.

Hitboxes are non-interactive and are currently rendered as red development wireframes. When a free
Handle interaction ends, the graph evaluates its source box against compatible target boxes in world
space and chooses the nearest overlap. The target's attachment recipe then creates the hierarchy
edge and optional constraint.

Every display currently owns a bottom snap target accepting keyboards. Dropping the keyboard's
GrabBox into it reparents the keyboard beneath that display and adds an x-axis hinge. The keyboard's
measured GrabBox size updates its snap-source box, so collision follows the actual loaded layout
rather than a permanently hardcoded proxy.

The default keyboard is created already attached to the primary display through this same bottom
hinge recipe. Recenter therefore moves the display workspace and keyboard as one assembly. If the
keyboard is deleted, reopening Layers recreates it on the current primary root display.

Future low-level edit mode should expose normally locked attachment transforms using the same
GrabBox/Handle contract. Origins are also transform nodes: multiple origin branches may coexist, but
a rendered Object3D has one structural parent. Showing the same logical item under two origins
requires two view instances backed by the same application model.

## Scale-to-delete

Deletable GrabBoxes compose a generic two-pointer scale policy with their ordinary Handle policy.
The gesture arms when the longest world-space GrabBox dimension drops below `0.10m` and disarms
above `0.13m`. The hysteresis prevents flicker around the boundary. While armed, a translucent red
sphere surrounds the element; releasing the final pointer deletes it. One-pointer manipulation and
cancelled pointer interactions cannot delete an element.

Parent deletion distinguishes spatial attachments from structurally owned implementation details.
Displays and keyboards use `onParentDelete: "preserve"`; buttons and other controls use
`onParentDelete: "cascade"`. A delete transaction does not commit the tiny final Handle transform.
Instead, cascade children are removed and the nearest preserved children are promoted to the deleted
node's parent while retaining their pre-gesture world transforms. Restoring a preserved child root
also cancels inherited scale for its complete subtree.

Display attachment roles are derived from the graph rather than stored. A display is `parent` when
it has a preserved attachment descendant, even when it is itself attached; otherwise an origin
display is `solo` and an attached display is `child`. Cascade-owned controls do not affect this
role. Topology controls are reconciled after structural operations, so deleting the last child
restores its former parent's spawn control. Reopening the Layers mode recreates a default display or
keyboard when that kind has been completely deleted.

Showing the window layer performs a one-shot recenter. The scene origin remains a static identity
reference frame; recenter writes a headset-relative pose to the primary root display, and its
attached subtree follows through normal hierarchy transforms. Desktop mode samples the R3F camera;
immersive mode samples the renderer's active XR camera rather than the fixed fallback camera.

## Prototype

The initial graph contains one display and its logically attached `+` control. Pressing it generates
another display with a hinge attachment, a new `+` control, and a hinge-release control. This forms
a data-driven monitor chain without a hardcoded Window 1/Window 2 limit. Releasing the hinge changes
only the constraint; the resulting detach control then reparents that subtree to the scene origin.
Persistent graph storage, actor commands, richer constraint UI, and origin selection come later.
