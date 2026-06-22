import { EOL } from "os";
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupContent,
  Range,
} from "vscode-languageserver";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import { isNode, isScalar, Node, YAMLMap } from "yaml";
import { IOption } from "../interfaces/module";
import { WorkspaceFolderContext } from "../services/workspaceManager";
import {
  blockKeywords,
  playKeywords,
  playWithoutTaskKeywords,
  roleKeywords,
  taskKeywords,
} from "../utils/ansible";
import { formatModule, formatOption, getDetails } from "../utils/docsFormatter";
import { insert, toLspRange } from "../utils/misc";
import {
  AncestryBuilder,
  findProvidedModule,
  getDeclaredCollections,
  getPathAt,
  getOrigRange,
  getYamlMapKeys,
  isBlockParam,
  isPlayParam,
  isRoleParam,
  isTaskParam,
  parseAllDocuments,
  getPossibleOptionsForPath,
  isCursorInsideJinjaBrackets,
  isPlaybook,
} from "../utils/yaml";
import { getVarsCompletion } from "./completionProviderUtils";
import { HostType } from "../services/ansibleInventory";

const priorityMap = {
  nameKeyword: 1,
  moduleName: 2,
  redirectedModuleName: 3,
  keyword: 4,
  // options
  requiredOption: 1,
  option: 2,
  aliasOption: 3,
  // choices
  defaultChoice: 1,
  choice: 2,
};

let dummyMappingCharacter: string;
let isAnsiblePlaybook: boolean;

export async function doCompletion(
  document: TextDocument,
  position: Position,
  context: WorkspaceFolderContext,
): Promise<CompletionItem[]> {
  isAnsiblePlaybook = isPlaybook(document);

  let preparedText = document.getText();
  const offset = document.offsetAt(position);

  // HACK: We need to insert a dummy mapping, so that the YAML parser can properly recognize the scope.
  // This is particularly important when parser has nothing more than indentation to
  // determine the scope of the current line.

  // This is handled w.r.t two scenarios:
  // 1. When we are at the key level, we use `_:` since we expect to work on a pair level.
  // 2. When we are at the value level, we use `__`. We do this because based on the above hack, the
  // use of `_:` at the value level creates invalid YAML as `: ` is an incorrect token in yaml string scalar

  dummyMappingCharacter = "_:";

  const previousCharactersOfCurrentLine = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: position.character },
  });

  if (previousCharactersOfCurrentLine.includes(": ")) {
    // this means we have encountered ": " previously in the same line and thus we are
    // at the value level
    dummyMappingCharacter = "__";
  }

  preparedText = insert(preparedText, offset, dummyMappingCharacter);
  const yamlDocs = parseAllDocuments(preparedText);

  const extensionSettings = await context.documentSettings.get(document.uri);

  const useFqcn = extensionSettings.ansible.useFullyQualifiedCollectionNames;
  const provideRedirectModulesCompletion =
    extensionSettings.completion.provideRedirectModules;
  const provideModuleOptionAliasesCompletion =
    extensionSettings.completion.provideModuleOptionAliases;

  // We need inclusive matching, since cursor position is the position of the character right after it
  // NOTE: Might no longer be required due to the hack above
  const path = getPathAt(document, position, yamlDocs, true);
  if (!path) {
    return [];
  }

  const node = path[path.length - 1];
  if (!node) {
    return [];
  }

  const docsLibrary = await context.docsLibrary;

  const taskCompletion = await getTaskOrKeywordCompletion(
    document,
    position,
    path,
    node,
    docsLibrary,
    useFqcn,
    provideRedirectModulesCompletion,
  );
  if (taskCompletion) {
    return taskCompletion;
  }

  const variableCompletion = getVariableCompletion(document, position, path);
  if (variableCompletion) {
    return variableCompletion;
  }

  const optionCompletion = await getOptionCompletion(
    document,
    position,
    path,
    node,
    docsLibrary,
    provideModuleOptionAliasesCompletion,
  );
  if (optionCompletion) {
    return optionCompletion;
  }

  const choiceCompletion = await getChoiceCompletion(
    document,
    path,
    node,
    docsLibrary,
  );
  if (choiceCompletion) {
    return choiceCompletion;
  }

  const hostCompletion = await getHostsCompletion(path, context);
  if (hostCompletion) {
    return hostCompletion;
  }

  return [];
}

async function getTaskOrKeywordCompletion(
  document: TextDocument,
  position: Position,
  path: Node[],
  node: Node,
  docsLibrary: Awaited<WorkspaceFolderContext["docsLibrary"]>,
  useFqcn: boolean,
  provideRedirectModulesCompletion: boolean,
): Promise<CompletionItem[] | null> {
  const isPlay = isPlayParam(path);
  if (isPlay) {
    return getKeywordCompletion(document, position, path, playKeywords);
  }

  if (isBlockParam(path)) {
    return getKeywordCompletion(document, position, path, blockKeywords);
  }

  if (isRoleParam(path)) {
    return getKeywordCompletion(document, position, path, roleKeywords);
  }

  if (!isTaskParam(path)) {
    return null;
  }

  // offer basic task keywords
  const completionItems = getKeywordCompletion(
    document,
    position,
    path,
    taskKeywords,
  );
  if (isPlay === undefined) {
    // this can still turn into a play, so we should offer those keywords too
    completionItems.push(
      ...getKeywordCompletion(
        document,
        position,
        path,
        playWithoutTaskKeywords,
      ),
    );
  }

  // incidentally, the hack mentioned above prevents finding a module in
  // case the cursor is on it
  const module = await findProvidedModule(path, document, docsLibrary);
  if (module) {
    return completionItems;
  }

  completionItems.push(
    ...(await getTaskModuleCompletion(
      document,
      position,
      path,
      node,
      docsLibrary,
      useFqcn,
      provideRedirectModulesCompletion,
    )),
  );

  return completionItems;
}

async function getTaskModuleCompletion(
  document: TextDocument,
  position: Position,
  path: Node[],
  node: Node,
  docsLibrary: Awaited<WorkspaceFolderContext["docsLibrary"]>,
  useFqcn: boolean,
  provideRedirectModulesCompletion: boolean,
): Promise<CompletionItem[]> {
  // offer the 'block' keyword (as it is not one of taskKeywords)
  const completionItems = getKeywordCompletion(
    document,
    position,
    path,
    new Map([["block", blockKeywords.get("block") as string]]),
  );

  const inlineCollections = getDeclaredCollections(path);
  const cursorAtEndOfLine = atEndOfLine(document, position);
  const nodeRange = getNodeRange(node, document);
  const cursorAtFirstElementOfList = firstElementOfList(document, nodeRange);

  // offer modules
  const moduleCompletionItems = [
    ...(await docsLibrary.getModuleFqcns(document.uri)),
  ]
    .filter(
      (moduleFqcn) =>
        provideRedirectModulesCompletion ||
        !docsLibrary.getModuleRoute(moduleFqcn)?.redirect,
    )
    .map((moduleFqcn): CompletionItem => {
      let priority, kind;
      if (docsLibrary.getModuleRoute(moduleFqcn)?.redirect) {
        priority = priorityMap.redirectedModuleName;
        kind = CompletionItemKind.Reference;
      } else {
        priority = priorityMap.moduleName;
        kind = CompletionItemKind.Class;
      }
      const [namespace, collection, name] = moduleFqcn.split(".");
      const insertName = useFqcn ? moduleFqcn : name;
      const insertText = cursorAtEndOfLine
        ? `${insertName}:${resolveSuffix(
            "dict", // since a module is always a dictionary
            cursorAtFirstElementOfList,
            isAnsiblePlaybook,
          )}`
        : insertName;
      const completionItem: CompletionItem = {
        label: useFqcn ? moduleFqcn : name,
        kind: kind,
        detail: `${namespace}.${collection}`,
        sortText: useFqcn ? `${priority}_${moduleFqcn}` : `${priority}_${name}`,
        filterText: useFqcn
          ? `${name} ${moduleFqcn} ${collection} ${namespace}` // name should have highest priority (in case of FQCN)
          : `${name} ${moduleFqcn}`, // name should have priority (in case of no FQCN)
        data: {
          documentUri: document.uri, // preserve document URI for completion request
          moduleFqcn: moduleFqcn,
          inlineCollections: inlineCollections,
          atEndOfLine: cursorAtEndOfLine,
          firstElementOfList: cursorAtFirstElementOfList,
        },
      };
      if (nodeRange) {
        completionItem.textEdit = {
          range: nodeRange,
          newText: insertText,
        };
      } else {
        completionItem.insertText = insertText;
      }
      return completionItem;
    });

  completionItems.push(...moduleCompletionItems);
  return completionItems;
}

function getVariableCompletion(
  document: TextDocument,
  position: Position,
  path: Node[],
): CompletionItem[] | null {
  // Provide variable auto-completion if the cursor is inside valid jinja inline brackets in a playbook
  if (!isAnsiblePlaybook) {
    return null;
  }

  if (!isCursorInsideJinjaBrackets(document, position, path)) {
    return null;
  }

  return getVarsCompletion(document.uri, path);
}

async function getOptionCompletion(
  document: TextDocument,
  position: Position,
  path: Node[],
  node: Node,
  docsLibrary: Awaited<WorkspaceFolderContext["docsLibrary"]>,
  provideModuleOptionAliasesCompletion: boolean,
): Promise<CompletionItem[] | null> {
  // Check if we're looking for module options or sub-options
  const options = await getPossibleOptionsForPath(path, document, docsLibrary);
  if (!options) {
    return null;
  }

  const optionMap = new AncestryBuilder(path)
    .parentOfKey()
    .get() as YAMLMap;

  // find options that have been already provided by the user
  const providedOptions = new Set(getYamlMapKeys(optionMap));
  const remainingOptions = [...options.entries()]
    .filter(([, specs]) => !providedOptions.has(specs.name))
    .map(([option, specs]) => {
      return {
        name: option,
        specs: specs,
      };
    })
    .filter(
      (option) =>
        provideModuleOptionAliasesCompletion || !isAlias(option),
    );

  const nodeRange = getNodeRange(node, document);
  const cursorAtFirstElementOfList = firstElementOfList(document, nodeRange);
  const cursorAtEndOfLine = atEndOfLine(document, position);

  return remainingOptions.map((option, index) => {
    // translate option documentation to CompletionItem
    const details = getDetails(option.specs);
    const priority = getOptionPriority(option);
    const completionItem: CompletionItem = {
      label: option.name,
      detail: details,
      // using index preserves order from the specification
      // except when overridden by the priority
      sortText: priority.toString() + index.toString().padStart(3),
      kind: isAlias(option)
        ? CompletionItemKind.Reference
        : CompletionItemKind.Property,
      documentation: formatOption(option.specs),
      data: {
        documentUri: document.uri, // preserve document URI for completion request
        type: option.specs.type,
        range: nodeRange,
        atEndOfLine: cursorAtEndOfLine,
        firstElementOfList: cursorAtFirstElementOfList,
      },
    };
    const insertText = cursorAtEndOfLine ? `${option.name}:` : option.name;
    if (nodeRange) {
      completionItem.textEdit = {
        range: nodeRange,
        newText: insertText,
      };
    } else {
      completionItem.insertText = insertText;
    }
    return completionItem;
  });
}

async function getChoiceCompletion(
  document: TextDocument,
  path: Node[],
  node: Node,
  docsLibrary: Awaited<WorkspaceFolderContext["docsLibrary"]>,
): Promise<CompletionItem[] | null> {
  const keyPath = getChoiceKeyPath(path);
  const keyNode = keyPath?.[keyPath.length - 1];
  if (!keyPath || !isScalar(keyNode)) {
    return null;
  }

  const keyOptions = await getPossibleOptionsForPath(
    keyPath,
    document,
    docsLibrary,
  );
  if (!keyOptions?.has(keyNode.value as string)) {
    return null;
  }

  const option = keyOptions.get(keyNode.value as string);
  if (!option) {
    return null;
  }

  const nodeRange = getNodeRange(node, document);
  const defaultChoice = getDefaultChoice(option);
  const choices = getChoices(option, defaultChoice);

  return choices.map((choice, index) => {
    const priority =
      choice === defaultChoice ? priorityMap.defaultChoice : priorityMap.choice;
    const insertValue = new String(choice).toString();
    const completionItem: CompletionItem = {
      label: insertValue,
      detail: choice === defaultChoice ? "default" : undefined,
      // using index preserves order from the specification
      // except when overridden by the priority
      sortText: priority.toString() + index.toString().padStart(3),
      kind: CompletionItemKind.Value,
    };
    if (nodeRange) {
      completionItem.textEdit = {
        range: nodeRange,
        newText: insertValue,
      };
    } else {
      completionItem.insertText = insertValue;
    }
    return completionItem;
  });
}

function getChoiceKeyPath(path: Node[]): Node[] | null {
  // establish path for the key (option/sub-option name)
  if (new AncestryBuilder(path).parent(YAMLMap).getValue() === null) {
    return new AncestryBuilder(path)
      .parent(YAMLMap) // compensates for DUMMY MAPPING
      .parent(YAMLMap)
      .getKeyPath();
  }

  // in this case there is a character immediately after DUMMY MAPPING, which
  // prevents formation of nested map
  return new AncestryBuilder(path).parent(YAMLMap).getKeyPath();
}

function getDefaultChoice(option: IOption): IOption["default"] | boolean {
  let defaultChoice = option.default;
  if (option.type === "bool" && typeof option.default === "string") {
    // the YAML parser does not recognize values such as 'Yes'/'no' as booleans
    defaultChoice = option.default.toLowerCase() === "yes" ? true : false;
  }
  return defaultChoice;
}

function getChoices(
  option: IOption,
  defaultChoice: IOption["default"] | boolean,
): Array<IOption["default"] | boolean> {
  if (option.choices) {
    return [...option.choices];
  }

  if (option.type === "bool") {
    return [true, false];
  }

  if (defaultChoice !== undefined) {
    return [defaultChoice];
  }

  return [];
}

async function getHostsCompletion(
  path: Node[],
  context: WorkspaceFolderContext,
): Promise<CompletionItem[] | null> {
  // check for 'hosts' keyword and 'ansible_host keyword under vars' to provide inventory auto-completion
  const keyPathForHosts = getHostsKeyPath(path);
  const keyNodeForHosts = keyPathForHosts?.[keyPathForHosts.length - 1];
  if (!keyPathForHosts || !keyNodeForHosts) {
    return null;
  }

  if (!shouldProvideHostCompletion(keyPathForHosts, keyNodeForHosts)) {
    return null;
  }

  // const nodeRange = getNodeRange(node, document);
  // nodeRange is not being passed to getHostCompletion because this will prevent
  // completion for items beyond ',', ':', '!', and we know that 'hosts' keyword supports regex
  const hostsList = (await context.ansibleInventory).hostList;
  return getHostCompletion(hostsList);
}

function getHostsKeyPath(path: Node[]): Node[] | null {
  const element = new AncestryBuilder(path).parent(YAMLMap).getValue();
  if (isNode(element) && isScalar(element) && element["value"] === null) {
    return new AncestryBuilder(path)
      .parent(YAMLMap) // compensates for DUMMY MAPPING
      .parent(YAMLMap)
      .getKeyPath();
  }

  return new AncestryBuilder(path)
    .parent(YAMLMap) // compensates for DUMMY MAPPING
    .getKeyPath();
}

function shouldProvideHostCompletion(
  keyPathForHosts: Node[],
  keyNodeForHosts: Node,
): boolean {
  const conditionForHostsKeyword =
    isPlayParam(keyPathForHosts) &&
    isScalar(keyNodeForHosts) &&
    keyNodeForHosts["value"] === "hosts";

  const conditionForAnsibleHostKeyword =
    isScalar(keyNodeForHosts) &&
    keyNodeForHosts["value"] === "ansible_host" &&
    new AncestryBuilder(keyPathForHosts)
      .parent()
      .parent(YAMLMap)
      .getStringKey() === "vars";

  return conditionForHostsKeyword || conditionForAnsibleHostKeyword;
}

function getOptionPriority(option: { name: string; specs: IOption }): number {
  if (isAlias(option)) {
    return priorityMap.aliasOption;
  }

  if (option.specs.required) {
    return priorityMap.requiredOption;
  }

  return priorityMap.option;
}

function getKeywordCompletion(
  document: TextDocument,
  position: Position,
  path: Node[],
  keywords: Map<string, string | MarkupContent>,
): CompletionItem[] {
  const parameterMap = new AncestryBuilder(path)
    .parent(YAMLMap)
    .get() as YAMLMap;
  // find options that have been already provided by the user
  const providedParams = new Set(getYamlMapKeys(parameterMap));

  const remainingParams = [...keywords.entries()].filter(
    ([keyword]) => !providedParams.has(keyword),
  );
  const nodeRange = getNodeRange(path[path.length - 1], document);
  return remainingParams.map(([keyword, description]) => {
    const priority =
      keyword === "name" ? priorityMap.nameKeyword : priorityMap.keyword;
    const completionItem: CompletionItem = {
      label: keyword,
      kind: CompletionItemKind.Property,
      sortText: `${priority}_${keyword}`,
      documentation: description,
    };
    const insertText = atEndOfLine(document, position)
      ? `${keyword}:`
      : keyword;
    if (nodeRange) {
      completionItem.textEdit = {
        range: nodeRange,
        newText: insertText,
      };
    } else {
      completionItem.insertText = insertText;
    }
    return completionItem;
  });
}

function getHostCompletion(hostObjectList: HostType[]): CompletionItem[] {
  return hostObjectList.map(({ host, priority }) => {
    const completionItem: CompletionItem = {
      label: host,
      sortText: `${priority}_${host}`,
      kind: [1, 2].includes(priority)
        ? CompletionItemKind.Variable
        : CompletionItemKind.Value,
    };
    return completionItem;
  });
}

/**
 * Returns an LSP formatted range compensating for the DUMMY MAPPING hack, provided that
 * the node has range information and is a string scalar.
 */
function getNodeRange(node: Node, document: TextDocument): Range | undefined {
  const range = getOrigRange(node);
  if (range && isScalar(node) && typeof node.value === "string") {
    const start = range[0];
    let end = range[1];
    // compensate for DUMMY MAPPING
    if (node.value.includes(dummyMappingCharacter)) {
      end -= 2;
    } else {
      // colon, being at the end of the line, was excluded from the node
      end -= 1;
    }
    return toLspRange([start, end], document);
  }
}

export async function doCompletionResolve(
  completionItem: CompletionItem,
  context: WorkspaceFolderContext,
): Promise<CompletionItem> {
  await resolveModuleCompletionItem(completionItem, context);
  resolveTypeCompletionItem(completionItem);
  return completionItem;
}

async function resolveModuleCompletionItem(
  completionItem: CompletionItem,
  context: WorkspaceFolderContext,
): Promise<void> {
  const moduleFqcn = completionItem.data?.moduleFqcn;
  const documentUri = completionItem.data?.documentUri;

  if (!moduleFqcn || !documentUri) {
    return;
  }

  // resolve completion for a module

  const docsLibrary = await context.docsLibrary;
  const [module] = await docsLibrary.findModule(moduleFqcn);

  if (!module?.documentation) {
    return;
  }

  const [namespace, collection, name] = moduleFqcn.split(".");
  const useFqcn = await shouldUseFqcn(
    completionItem,
    context,
    documentUri,
    namespace,
    collection,
  );
  const insertName = useFqcn ? moduleFqcn : name;
  const insertText = getCompletionInsertText(
    insertName,
    "dict", // since a module is always a dictionary
    completionItem.data.atEndOfLine,
    completionItem.data.firstElementOfList,
  );

  applyCompletionInsertText(
    completionItem,
    insertText,
    InsertTextFormat.Snippet,
    InsertTextFormat.PlainText,
  );

  completionItem.documentation = formatModule(
    module.documentation,
    docsLibrary.getModuleRoute(moduleFqcn),
  );
}

async function shouldUseFqcn(
  completionItem: CompletionItem,
  context: WorkspaceFolderContext,
  documentUri: string,
  namespace: string,
  collection: string,
): Promise<boolean> {
  let useFqcn = (await context.documentSettings.get(documentUri)).ansible
    .useFullyQualifiedCollectionNames;

  if (useFqcn) {
    return true;
  }

  // determine if the short name can really be used

  const declaredCollections = [
    ...(completionItem.data?.inlineCollections || []),
    "ansible.builtin",
  ];
  const metadata = await context.documentMetadata.get(documentUri);
  if (metadata) {
    declaredCollections.push(...metadata.collections);
  }

  const canUseShortName = declaredCollections.some(
    (c) => c === `${namespace}.${collection}`,
  );
  if (!canUseShortName) {
    // not an Ansible built-in module, and not part of the declared
    // collections
    useFqcn = true;
  }

  return useFqcn;
}

function resolveTypeCompletionItem(completionItem: CompletionItem): void {
  if (!completionItem.data?.type) {
    return;
  }

  // resolve completion for a module option or sub-option

  const insertText = getCompletionInsertText(
    completionItem.label,
    completionItem.data.type,
    completionItem.data.atEndOfLine,
    completionItem.data.firstElementOfList,
  );

  applyCompletionInsertText(completionItem, insertText);
}

function getCompletionInsertText(
  label: string,
  type: string,
  atEndOfLine: boolean,
  firstElementOfList: boolean,
): string {
  if (!atEndOfLine) {
    return label;
  }

  return `${label}:${resolveSuffix(
    type,
    firstElementOfList,
    isAnsiblePlaybook,
  )}`;
}

function applyCompletionInsertText(
  completionItem: CompletionItem,
  insertText: string,
  textEditFormat?: InsertTextFormat,
  insertTextFormat?: InsertTextFormat,
): void {
  if (completionItem.textEdit) {
    completionItem.textEdit.newText = insertText;
    if (textEditFormat) {
      completionItem.insertTextFormat = textEditFormat;
    }
    return;
  }

  completionItem.insertText = insertText;
  if (insertTextFormat) {
    completionItem.insertTextFormat = insertTextFormat;
  }
}

function isAlias(option: { name: string; specs: IOption }): boolean {
  return option.name !== option.specs.name;
}

function atEndOfLine(document: TextDocument, position: Position): boolean {
  const charAfterCursor = `${document.getText()}\n`[
    document.offsetAt(position)
  ];
  return charAfterCursor === "\n" || charAfterCursor === "\r";
}

/**
 * A utility function to check if the item is the first element of a list or not
 * @param document - current document
 * @param nodeRange - range of the keyword in the document
 * @returns boolean true if the key is the first element of the list, else false
 */
function firstElementOfList(
  document: TextDocument,
  nodeRange: Range | undefined,
): boolean {
  if (!nodeRange) {
    return false;
  }
  const checkNodeRange = {
    start: { line: nodeRange.start.line, character: 0 },
    end: nodeRange.start,
  };
  const elementsBeforeKey = document.getText(checkNodeRange).trim();

  return elementsBeforeKey === "-";
}

export function resolveSuffix(
  optionType: string,
  firstElementOfList: boolean,
  isDocPlaybook: boolean,
) {
  let returnSuffix: string;

  if (isDocPlaybook) {
    // if doc is a playbook, indentation will shift one tab since a play is a list
    switch (optionType) {
      case "list":
        returnSuffix = firstElementOfList ? `${EOL}\t\t- ` : `${EOL}\t- `;
        break;
      case "dict":
        returnSuffix = firstElementOfList ? `${EOL}\t\t` : `${EOL}\t`;
        break;
      default:
        returnSuffix = " ";
        break;
    }
  } else {
    // if doc is not a playbook (any other ansible file like task file, etc.) indentation will not
    // include that extra tab
    switch (optionType) {
      case "list":
        returnSuffix = `${EOL}\t- `;
        break;
      case "dict":
        returnSuffix = `${EOL}\t`;
        break;
      default:
        returnSuffix = " ";
        break;
    }
  }

  return returnSuffix;
}
