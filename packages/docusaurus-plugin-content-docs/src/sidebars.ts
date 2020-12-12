/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import flatMap from 'lodash.flatmap';
import fs from 'fs-extra';
import importFresh from 'import-fresh';
import {
  Sidebars,
  SidebarItem,
  SidebarItemLink,
  SidebarItemDoc,
  Sidebar,
  SidebarItemCategory,
  SidebarItemType,
} from './types';
import {mapValues, flatten, difference} from 'lodash';
import {getElementsAround} from '@docusaurus/utils';

type SidebarItemCategoryJSON = {
  type: 'category';
  label: string;
  items: SidebarItemJSON[];
  collapsed?: boolean;
};

type SidebarItemJSON =
  | string
  | SidebarCategoryShorthandJSON
  | SidebarItemDoc
  | SidebarItemLink
  | SidebarItemCategoryJSON
  | {
      type: string;
      [key: string]: unknown;
    };

type SidebarCategoryShorthandJSON = {
  [sidebarCategory: string]: SidebarItemJSON[];
};

type SidebarJSON = SidebarCategoryShorthandJSON | SidebarItemJSON[];

// Sidebar given by user that is not normalized yet. e.g: sidebars.json
type SidebarsJSON = {
  [sidebarId: string]: SidebarJSON;
};

function isCategoryShorthand(
  item: SidebarItemJSON,
): item is SidebarCategoryShorthandJSON {
  return typeof item !== 'string' && !item.type;
}

// categories are collapsed by default, unless user set collapsed = false
const defaultCategoryCollapsedValue = true;

/**
 * Convert {category1: [item1,item2]} shorthand syntax to long-form syntax
 */
function normalizeCategoryShorthand(
  sidebar: SidebarCategoryShorthandJSON,
): SidebarItemCategoryJSON[] {
  return Object.entries(sidebar).map(([label, items]) => ({
    type: 'category',
    collapsed: defaultCategoryCollapsedValue,
    label,
    items,
  }));
}

/**
 * Check that item contains only allowed keys.
 */
function assertItem<K extends string>(
  item: any,
  keys: K[],
): asserts item is Record<K, any> {
  const unknownKeys = Object.keys(item).filter(
    // @ts-expect-error: key is always string
    (key) => !keys.includes(key as string) && key !== 'type',
  );

  if (unknownKeys.length) {
    throw new Error(
      `Unknown sidebar item keys: ${unknownKeys}. Item: ${JSON.stringify(
        item,
      )}`,
    );
  }
}

function assertIsCategory(
  item: unknown,
): asserts item is SidebarItemCategoryJSON {
  assertItem(item, ['items', 'label', 'collapsed']);
  if (typeof item.label !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "label" must be a string.`,
    );
  }
  if (!Array.isArray(item.items)) {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "items" must be an array.`,
    );
  }
  // "collapsed" is an optional property
  if (item.hasOwnProperty('collapsed') && typeof item.collapsed !== 'boolean') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "collapsed" must be a boolean.`,
    );
  }
}

function assertIsDoc(item: unknown): asserts item is SidebarItemDoc {
  assertItem(item, ['id']);
  if (typeof item.id !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "id" must be a string.`,
    );
  }
}

function assertIsLink(item: unknown): asserts item is SidebarItemLink {
  assertItem(item, ['href', 'label']);
  if (typeof item.href !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "href" must be a string.`,
    );
  }
  if (typeof item.label !== 'string') {
    throw new Error(
      `Error loading ${JSON.stringify(item)}. "label" must be a string.`,
    );
  }
}

/**
 * Normalizes recursively item and all its children. Ensures that at the end
 * each item will be an object with the corresponding type.
 */
function normalizeItem(item: SidebarItemJSON): SidebarItem[] {
  if (typeof item === 'string') {
    return [
      {
        type: 'doc',
        id: item,
      },
    ];
  }
  if (isCategoryShorthand(item)) {
    return flatMap(normalizeCategoryShorthand(item), normalizeItem);
  }
  switch (item.type) {
    case 'category':
      assertIsCategory(item);
      return [
        {
          collapsed: defaultCategoryCollapsedValue,
          ...item,
          items: flatMap(item.items, normalizeItem),
        },
      ];
    case 'link':
      assertIsLink(item);
      return [item];
    case 'ref':
    case 'doc':
      assertIsDoc(item);
      return [item];
    default: {
      const extraMigrationError =
        item.type === 'subcategory'
          ? "Docusaurus v2: 'subcategory' has been renamed as 'category'"
          : '';
      throw new Error(
        `Unknown sidebar item type [${
          item.type
        }]. Sidebar item=${JSON.stringify(item)} ${extraMigrationError}`,
      );
    }
  }
}

function normalizeSidebar(sidebar: SidebarJSON) {
  const normalizedSidebar: SidebarItemJSON[] = Array.isArray(sidebar)
    ? sidebar
    : normalizeCategoryShorthand(sidebar);

  return flatMap(normalizedSidebar, normalizeItem);
}

function normalizeSidebars(sidebars: SidebarsJSON): Sidebars {
  return mapValues(sidebars, normalizeSidebar);
}

// TODO refactor: make async
export function loadSidebars(sidebarFilePath: string): Sidebars {
  if (!sidebarFilePath) {
    throw new Error(`sidebarFilePath not provided: ${sidebarFilePath}`);
  }

  // sidebars file is optional, some users use docs without sidebars!
  // See https://github.com/facebook/docusaurus/issues/3366
  if (!fs.existsSync(sidebarFilePath)) {
    // throw new Error(`No sidebar file exist at path: ${sidebarFilePath}`);
    return {};
  }

  // We don't want sidebars to be cached because of hot reloading.
  const sidebarJson = importFresh(sidebarFilePath) as SidebarsJSON;
  return normalizeSidebars(sidebarJson);
}

function collectSidebarItemsOfType<
  Type extends SidebarItemType,
  Item extends SidebarItem & {type: SidebarItemType}
>(type: Type, sidebar: Sidebar): Item[] {
  function collectRecursive(item: SidebarItem): Item[] {
    const currentItemsCollected: Item[] =
      item.type === type ? [item as Item] : [];

    const childItemsCollected: Item[] =
      item.type === 'category' ? flatten(item.items.map(collectRecursive)) : [];

    return [...currentItemsCollected, ...childItemsCollected];
  }

  return flatten(sidebar.map(collectRecursive));
}

export function collectSidebarDocItems(sidebar: Sidebar): SidebarItemDoc[] {
  return collectSidebarItemsOfType('doc', sidebar);
}
export function collectSidebarCategories(
  sidebar: Sidebar,
): SidebarItemCategory[] {
  return collectSidebarItemsOfType('category', sidebar);
}
export function collectSidebarLinks(sidebar: Sidebar): SidebarItemLink[] {
  return collectSidebarItemsOfType('link', sidebar);
}

export function transformSidebarItems(
  sidebar: Sidebar,
  updateFn: (item: SidebarItem) => SidebarItem,
): Sidebar {
  function transformRecursive(item: SidebarItem): SidebarItem {
    if (item.type === 'category') {
      return updateFn({
        ...item,
        items: item.items.map(transformRecursive),
      });
    }
    return updateFn(item);
  }
  return sidebar.map(transformRecursive);
}

export function collectSidebarsDocIds(
  sidebars: Sidebars,
): Record<string, string[]> {
  return mapValues(sidebars, (sidebar) => {
    return collectSidebarDocItems(sidebar).map((docItem) => docItem.id);
  });
}

export function createSidebarsUtils(
  sidebars: Sidebars,
): Record<string, Function> {
  const sidebarNameToDocIds = collectSidebarsDocIds(sidebars);

  function getFirstDocIdOfFirstSidebar(): string | undefined {
    return Object.values(sidebarNameToDocIds)[0]?.[0];
  }

  function getSidebarNameByDocId(docId: string): string | undefined {
    // TODO lookup speed can be optimized
    const entry = Object.entries(
      sidebarNameToDocIds,
    ).find(([_sidebarName, docIds]) => docIds.includes(docId));

    return entry?.[0];
  }

  function getDocNavigation(
    docId: string,
  ): {
    sidebarName: string | undefined;
    previousId: string | undefined;
    nextId: string | undefined;
  } {
    const sidebarName = getSidebarNameByDocId(docId);
    if (sidebarName) {
      const docIds = sidebarNameToDocIds[sidebarName];
      const currentIndex = docIds.indexOf(docId);
      const {previous, next} = getElementsAround(docIds, currentIndex);
      return {
        sidebarName,
        previousId: previous,
        nextId: next,
      };
    } else {
      return {
        sidebarName: undefined,
        previousId: undefined,
        nextId: undefined,
      };
    }
  }

  function checkSidebarsDocIds(validDocIds: string[]) {
    const allSidebarDocIds = flatten(Object.values(sidebarNameToDocIds));
    const invalidSidebarDocIds = difference(allSidebarDocIds, validDocIds);
    if (invalidSidebarDocIds.length > 0) {
      throw new Error(
        `Bad sidebars file.
These sidebar document ids do not exist:
- ${invalidSidebarDocIds.sort().join('\n- ')},

Available document ids=
- ${validDocIds.sort().join('\n- ')}`,
      );
    }
  }
  function checkOrphanDocs() {
    const all_docs = new Set();
    const non_orphan = new Set();
    let added = false;
    // finds all .md or .mdx files in docs, update for subdirs
    const directory = './docs/';
    fs.readdirSync(directory).forEach((file) => {
      if (file.endsWith('.md') || file.endsWith('.mdx')) {
        all_docs.add(file);
        const path = directory + file;
        const data = fs.readFileSync(path, {encoding: 'utf8', flag: 'r'});
        const lines = data.split('\n');
        for (const line of lines) {
          if (line.startsWith('id:')) {
            const doc_id = line.substring(4);
            const sidebar_name = getSidebarNameByDocId(doc_id);
            if (sidebar_name) {
              if (!non_orphan.has(file)) {
                added = true;
              }
              non_orphan.add(file);
            }
            break;
          }
        }
      }
    });
    // using list of non orphan docs, while we keep adding new elements traverse files

    if (added) {
      let update = true;
      while (update) {
        update = false;
        for (const item of non_orphan) {
          const path = directory + item;
          const data = fs.readFileSync(path, {encoding: 'utf8', flag: 'r'});
          const lines = data.split('\n');
          for (const line of lines) {
            // opification you find broken CSS, build your website with the environment variable `USE_SIMPLE_CSS_MINIFIER=true` to minify CSS with the [default cssnano preset](https://github.com/cssnano/cssnano/tree/master/packages/cssnano-preset-default). **Please [fill out an issue](https://github.com/facebook/docusaurus/issues/new?labels=bug%2C+needs+triage&template=bug.md) if you experience CSS minification bugs.**"
            const arr = line.match(/\[.*?\]\(.+?\)/g);
            if (arr) {
              for (const re of arr) {
                const temp = re.match(/\(.+mdx?\)/);
                if (temp) {
                  let target = temp[0];
                  const len = target.length;
                  target = target.substr(1, len - 2);
                  if (!non_orphan.has(target) && all_docs.has(target)) {
                    non_orphan.add(target);
                    update = true;
                  }
                }
              }
            }
          }
        }
      }
    }
    // outputs all orphan docs
    for (const key of all_docs) {
      if (!non_orphan.has(key) && added) {
        console.log(`WARNING: ${key} is an orphan doc`);
      }
    }
  }
  return {
    getFirstDocIdOfFirstSidebar,
    getSidebarNameByDocId,
    getDocNavigation,
    checkSidebarsDocIds,
    checkOrphanDocs,
  };
}
