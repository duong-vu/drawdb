import { tableWidth as defaultTableWidth } from "../data/constants";
import { getTableHeight, getTableWidth } from "./utils";

const nodeSep = 60;
const rankSep = 110;
const componentGap = 110;
const isolatedGap = 60;
const orderingSweeps = 8;

/**
 * Lays out unlocked tables in layers by their foreign keys.
 *
 * Tables that reference no other table go in the leftmost layer, and every
 * other table goes one layer to the right of the deepest table it references.
 * Separate groups of related tables are stacked vertically, and tables with no
 * relationships are placed in a grid below them. Locked tables are not moved.
 *
 * Returns the new top-left position of each unlocked table, anchored at the
 * top-left corner of where those tables are now.
 */
export function autoArrange(tables, relationships, settings) {
  const movable = tables.filter((table) => !table.locked);
  if (movable.length === 0) return [];

  const movableIds = new Set(movable.map((table) => table.id));
  const sizes = new Map(
    movable.map((table) => [
      table.id,
      {
        width: getTableWidth(table),
        height: getTableHeight(table, settings.showComments, relationships),
      },
    ]),
  );

  // A relationship starts at the table holding the foreign key and ends at the
  // table it references, so the referenced table is the parent.
  const parents = new Map(movable.map((table) => [table.id, new Set()]));
  const children = new Map(movable.map((table) => [table.id, new Set()]));
  for (const r of relationships) {
    const child = r.startTableId;
    const parent = r.endTableId;
    if (child === parent || !movableIds.has(child) || !movableIds.has(parent)) {
      continue;
    }
    parents.get(child).add(parent);
    children.get(parent).add(child);
  }

  const isConnected = (id) =>
    parents.get(id).size > 0 || children.get(id).size > 0;
  const connected = movable.filter((table) => isConnected(table.id));
  const isolated = movable.filter((table) => !isConnected(table.id));

  const positions = [];
  let y = 0;
  let maxX = 0;
  for (const component of findComponents(connected, parents, children)) {
    const placed = layoutComponent(component, parents, children, sizes);
    let bottom = y;
    for (const p of placed) {
      positions.push({ id: p.id, x: p.x, y: p.y + y });
      const { width, height } = sizes.get(p.id);
      maxX = Math.max(maxX, p.x + width);
      bottom = Math.max(bottom, p.y + y + height);
    }
    y = bottom + componentGap;
  }

  if (isolated.length > 0) {
    const rowWidth = Math.max(maxX, 4 * defaultTableWidth + 3 * isolatedGap);
    let x = 0;
    let rowHeight = 0;
    for (const table of isolated) {
      const { width, height } = sizes.get(table.id);
      if (x > 0 && x + width > rowWidth) {
        x = 0;
        y += rowHeight + isolatedGap;
        rowHeight = 0;
      }
      positions.push({ id: table.id, x, y });
      x += width + isolatedGap;
      rowHeight = Math.max(rowHeight, height);
    }
  }

  const originX = Math.min(...movable.map((table) => table.x));
  const originY = Math.min(...movable.map((table) => table.y));
  return positions.map((p) => ({
    id: p.id,
    x: Math.round(p.x + originX),
    y: Math.round(p.y + originY),
  }));
}

/** Groups related tables, keeping the diagram's table order. */
function findComponents(connected, parents, children) {
  const seen = new Set();
  const components = [];
  for (const table of connected) {
    if (seen.has(table.id)) continue;
    const ids = new Set([table.id]);
    const stack = [table.id];
    seen.add(table.id);
    while (stack.length > 0) {
      const id = stack.pop();
      for (const next of [...parents.get(id), ...children.get(id)]) {
        if (seen.has(next)) continue;
        seen.add(next);
        ids.add(next);
        stack.push(next);
      }
    }
    components.push(connected.filter((t) => ids.has(t.id)).map((t) => t.id));
  }
  return components;
}

/**
 * Assigns each table in a component to a layer and an order within it, then
 * converts that to coordinates relative to the component's top-left corner.
 */
function layoutComponent(ids, parents, children, sizes) {
  const inComponent = new Set(ids);
  const dagParents = removeCycles(ids, parents, children);

  // Longest path from a root: each table sits right of everything it references.
  const layerOf = new Map();
  const visiting = new Set();
  const layerFor = (id) => {
    if (layerOf.has(id)) return layerOf.get(id);
    visiting.add(id);
    let layer = 0;
    for (const parent of dagParents.get(id)) {
      if (!visiting.has(parent)) layer = Math.max(layer, layerFor(parent) + 1);
    }
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  ids.forEach(layerFor);

  const layers = [];
  for (const id of ids) {
    const layer = layerOf.get(id);
    (layers[layer] ??= []).push(id);
  }

  // Reorder each layer by the average position of its neighbors in the layers
  // already placed, sweeping right then left, to reduce crossing lines.
  const neighbors = (id) =>
    [...parents.get(id), ...children.get(id)].filter((n) => inComponent.has(n));
  const rankOf = new Map();
  const updateRanks = (layer) =>
    layer.forEach((id, i) => rankOf.set(id, (i + 0.5) / layer.length));
  layers.forEach(updateRanks);
  for (let sweep = 0; sweep < orderingSweeps; sweep++) {
    const rightward = sweep % 2 === 0;
    const order = rightward
      ? layers.map((_, i) => i).slice(1)
      : layers
          .map((_, i) => i)
          .reverse()
          .slice(1);
    for (const index of order) {
      const isReference = (n) =>
        rightward ? layerOf.get(n) < index : layerOf.get(n) > index;
      const barycenter = new Map();
      for (const id of layers[index]) {
        const refs = neighbors(id).filter(isReference);
        barycenter.set(
          id,
          refs.length === 0
            ? rankOf.get(id)
            : refs.reduce((sum, n) => sum + rankOf.get(n), 0) / refs.length,
        );
      }
      layers[index] = [...layers[index]].sort(
        (a, b) => barycenter.get(a) - barycenter.get(b),
      );
      updateRanks(layers[index]);
    }
  }

  // Columns are as wide as their widest table; each column is centered
  // vertically against the tallest one.
  const columnHeights = layers.map(
    (layer) =>
      layer.reduce((sum, id) => sum + sizes.get(id).height, 0) +
      (layer.length - 1) * nodeSep,
  );
  const tallest = Math.max(...columnHeights);

  const placed = [];
  let x = 0;
  layers.forEach((layer, index) => {
    let y = (tallest - columnHeights[index]) / 2;
    let columnWidth = 0;
    for (const id of layer) {
      const { width, height } = sizes.get(id);
      placed.push({ id, x, y });
      y += height + nodeSep;
      columnWidth = Math.max(columnWidth, width);
    }
    x += columnWidth + rankSep;
  });
  return placed;
}

/**
 * Drops the references that close a cycle, so every table still has a layer.
 * Starts from tables that reference nothing, so roots keep the leftmost layer.
 */
function removeCycles(ids, parents, children) {
  const dagParents = new Map(ids.map((id) => [id, new Set(parents.get(id))]));
  const state = new Map();
  const visit = (id) => {
    state.set(id, "active");
    for (const child of children.get(id)) {
      if (!dagParents.has(child)) continue;
      if (state.get(child) === "active") {
        dagParents.get(child).delete(id);
      } else if (!state.has(child)) {
        visit(child);
      }
    }
    state.set(id, "done");
  };
  const roots = ids.filter((id) => parents.get(id).size === 0);
  for (const id of [...roots, ...ids]) {
    if (!state.has(id)) visit(id);
  }
  return dagParents;
}
