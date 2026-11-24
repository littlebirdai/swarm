/* @license Adapted from get-bb/bb. See oxlint-plugin.LICENSE. */
import { isSemanticComment } from "./lib/semantic-comment.mjs";

const blockingChildProcessCalls = new Set([
  "execFileSync",
  "execSync",
  "spawnSync",
]);

const noBlockingChildProcessCall = {
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          blockingChildProcessCalls.has(node.callee.name)
        ) {
          context.report({
            node: node.callee,
            message:
              "Use async child_process APIs instead of blocking sync variants.",
          });
        }
      },
    };
  },
};

const rawChildProcessModules = new Set([
  "node:child_process",
  "child_process",
  "cross-spawn",
  "execa",
]);

const noRawChildProcess = {
  create(context) {
    function check(node, typeOnly) {
      if (typeOnly) return;
      if (node?.type !== "Literal" || typeof node.value !== "string") return;
      if (!rawChildProcessModules.has(node.value)) return;
      context.report({
        node,
        message: `${node.value} spawns outside the host spawn policy. Use an async process helper that owns launch and cleanup.`,
      });
    }
    return {
      ImportDeclaration(node) {
        check(
          node.source,
          node.importKind === "type" ||
            (node.specifiers.length > 0 &&
              node.specifiers.every(
                (specifier) => specifier.importKind === "type",
              )),
        );
      },
      ExportNamedDeclaration(node) {
        check(node.source, node.exportKind === "type");
      },
      ExportAllDeclaration(node) {
        check(node.source, node.exportKind === "type");
      },
      ImportExpression(node) {
        check(node.source, false);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type !== "TSExternalModuleReference") return;
        check(node.moduleReference.expression, node.importKind === "type");
      },
      CallExpression(node) {
        const callee = calleeName(node.callee);
        if (callee === "require" || callee === "process.getBuiltinModule") {
          check(node.arguments[0], false);
        }
      },
    };
  },
};

function findJsxAttribute(node, name) {
  return node.attributes.find(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === name,
  );
}

const noNativeTitleWithAriaLabel = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        const titleAttribute = findJsxAttribute(node, "title");
        if (titleAttribute && findJsxAttribute(node, "aria-label")) {
          context.report({
            node: titleAttribute,
            message:
              "Do not pair aria-label with a native title tooltip. Use aria-label for the accessible name and a design-system Tooltip, or put title on the truncated text only.",
          });
        }
      },
    };
  },
};

const noNativeTitleOnButton = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "Button") {
          const titleAttribute = findJsxAttribute(node, "title");
          if (titleAttribute) {
            context.report({
              node: titleAttribute,
              message:
                "Do not put native title tooltips on the shared Button primitive. Use aria-label for icon-only buttons and a design-system Tooltip when visible hover help is intentional.",
            });
          }
        }
      },
    };
  },
};

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.property.type === "Identifier"
  ) {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

const noComments = {
  meta: {
    fixable: "whitespace",
  },
  create(context) {
    const sourceCode = context.sourceCode;

    return {
      Program() {
        const fileText = sourceCode.getText();

        for (const comment of sourceCode.getAllComments()) {
          const commentText = sourceCode.getText(comment);

          if (isSemanticComment(commentText)) {
            continue;
          }

          context.report({
            node: comment,
            message: "Code comments are forbidden.",
            fix(fixer) {
              if (/\r|\n/.test(commentText)) {
                return fixer.replaceText(
                  comment,
                  commentText.replace(/[^\r\n]/g, ""),
                );
              }

              const [start, end] = comment.range;
              const before = fileText[start - 1];
              const after = fileText[end];
              const needsSeparator =
                commentText.startsWith("/*") &&
                before !== undefined &&
                after !== undefined &&
                !/\s/.test(before) &&
                !/\s/.test(after);

              return fixer.replaceText(comment, needsSeparator ? " " : "");
            },
          });
        }
      },
    };
  },
};

const resizeObserverMessage =
  "Observe element sizes through a shared resize helper so updates can apply in the same frame.";

function isResizeObserverConstructor(callee) {
  if (callee.type === "Identifier") return callee.name === "ResizeObserver";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "ResizeObserver"
  );
}

const noRawResizeObserver = {
  create(context) {
    return {
      NewExpression(node) {
        if (isResizeObserverConstructor(node.callee)) {
          context.report({ node: node.callee, message: resizeObserverMessage });
        }
      },
      ImportDeclaration(node) {
        if (node.source.value !== "usehooks-ts") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "useResizeObserver"
          ) {
            context.report({ node: specifier, message: resizeObserverMessage });
          }
        }
      },
    };
  },
};

const imeSensitiveKeys = new Set(["Enter", "Escape"]);
const imeSafeKeyMessage = (key) =>
  `Check for IME composition before handling ${key}. A raw key check fires on the keystroke that confirms or cancels Chinese, Japanese, or Korean input-method composition; Safari reports that keystroke with isComposing false and keyCode 229.`;

function isKeyMember(node) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "key"
  );
}

function imeSensitiveKeyLiteral(node) {
  return node.type === "Literal" && imeSensitiveKeys.has(node.value)
    ? node.value
    : null;
}

const imeSafeKeyHandlers = {
  create(context) {
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        const key = isKeyMember(node.left)
          ? imeSensitiveKeyLiteral(node.right)
          : isKeyMember(node.right)
            ? imeSensitiveKeyLiteral(node.left)
            : null;
        if (key !== null) {
          context.report({ node, message: imeSafeKeyMessage(key) });
        }
      },
      SwitchCase(node) {
        const key =
          node.test === null ? null : imeSensitiveKeyLiteral(node.test);
        const switchStatement = node.parent;
        if (key !== null && isKeyMember(switchStatement.discriminant)) {
          context.report({ node, message: imeSafeKeyMessage(key) });
        }
      },
    };
  },
};

const noDirectUseEffect = {
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "useEffect") {
          context.report({
            node,
            message:
              "Direct useEffect is banned. Use useMountEffect() for one-time external sync, useEventListener() for event subscriptions, or derive state inline. See CLAUDE.md for patterns.",
          });
        }
      },
    };
  },
};

export const rules = {
  "ime-safe-key-handlers": imeSafeKeyHandlers,
  "no-blocking-child-process-call": noBlockingChildProcessCall,
  "no-comments": noComments,
  "no-direct-use-effect": noDirectUseEffect,
  "no-native-title-on-button": noNativeTitleOnButton,
  "no-native-title-with-aria-label": noNativeTitleWithAriaLabel,
  "no-raw-child-process": noRawChildProcess,
  "no-raw-resize-observer": noRawResizeObserver,
};

export default {
  meta: {
    name: "swarm",
  },
  rules,
};
