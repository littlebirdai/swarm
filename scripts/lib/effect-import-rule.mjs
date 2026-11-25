import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { effectZone, isEffectEntry, isEffectModule } from "./effect-zone.mjs";

const resolveModule = createRequire(import.meta.url).resolve;
const root = fileURLToPath(new URL("../../", import.meta.url));
const extensions = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];
const repoPath = (path) => relative(root, path).split(sep).join("/");

function literal(node) {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
}

function unwrap(node) {
  while (
    [
      "ChainExpression",
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSInstantiationExpression",
    ].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

function member(node) {
  if (node.type !== "MemberExpression") return;
  return node.computed ? literal(node.property) : node.property.name;
}

function relativeEffectImport(file, specifier) {
  if (!/^\.\.?[/\\]/.test(specifier)) return false;
  const target = resolve(dirname(file), specifier);
  if (!effectZone.test(repoPath(target))) return false;
  try {
    if (effectZone.test(repoPath(resolveModule(target)))) return true;
  } catch {}
  const stem = target.replace(/\.[cm]?jsx?$/, "");
  return [
    target,
    ...extensions.map((ext) => stem + ext),
    ...extensions.slice(1).map((ext) => resolve(target, "index" + ext)),
  ].some(
    (candidate) =>
      existsSync(candidate) &&
      statSync(candidate).isFile() &&
      effectZone.test(repoPath(realpathSync(candidate))),
  );
}

export const effectImports = {
  create(context) {
    const file = resolve(context.filename ?? context.getFilename());
    const inZone = effectZone.test(repoPath(file));
    const requireFactories = new Set(["createRequire"]);
    const bindings = [];
    const calls = [];

    function check(node, requireCall = false) {
      const name = literal(node);
      if (name === undefined) return;
      if (name === "effect") {
        context.report({
          node,
          message:
            "Import an Effect module subpath. The effect barrel is forbidden.",
        });
      } else if (
        !inZone &&
        (isEffectModule(name) ||
          isEffectEntry(name) ||
          /^@codecast\/effect-kit(?:\/|$)/.test(name) ||
          relativeEffectImport(file, name))
      ) {
        context.report({
          node,
          message: `${name} is restricted to Effect-zone packages.`,
        });
      } else if (requireCall && isEffectModule(name)) {
        context.report({
          node,
          message:
            "Use a named import from Effect so the stability of its exports can be checked.",
        });
      }
    }

    function isRequire(expression, aliases) {
      const node = unwrap(expression);
      if (node.type === "Identifier") return aliases.has(node.name);
      if (node.type === "CallExpression") {
        const callee = unwrap(node.callee);
        return callee.type === "Identifier"
          ? requireFactories.has(callee.name)
          : member(callee) === "createRequire";
      }
      if (node.type !== "MemberExpression") return false;
      const name = member(node);
      const object = unwrap(node.object);
      if (name === "resolve") {
        return (
          (object.type === "MetaProperty" && object.meta.name === "import") ||
          isRequire(object, aliases)
        );
      }
      if (object.type !== "Identifier") return false;
      return (
        (object.name === "Bun" && name === "resolveSync") ||
        (name === "require" &&
          ["module", "globalThis", "global"].includes(object.name))
      );
    }

    return {
      ImportDeclaration(node) {
        check(node.source);
        if (!["node:module", "module"].includes(literal(node.source))) return;
        for (const specifier of node.specifiers) {
          if (specifier.imported?.name === "createRequire")
            requireFactories.add(specifier.local.name);
        }
      },
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source ?? node.argument?.literal),
      TSExternalModuleReference: (node) => check(node.expression, true),
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init) bindings.push(node);
      },
      CallExpression(node) {
        if (literal(node.arguments[0]) !== undefined) calls.push(node);
      },
      "Program:exit"() {
        const aliases = new Set(["require"]);
        let previousSize;
        do {
          previousSize = aliases.size;
          for (const { id, init } of bindings) {
            if (isRequire(init, aliases)) aliases.add(id.name);
          }
        } while (aliases.size !== previousSize);
        for (const node of calls) {
          if (isRequire(node.callee, aliases)) check(node.arguments[0], true);
        }
      },
    };
  },
};
