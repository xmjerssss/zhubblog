/**
 * 代码高亮按需注册。
 *
 * `react-syntax-highlighter` 的 `Prism` 全量入口打包了 Prism 近 300 种语言，
 * 使 markdown 渲染链 chunk 膨胀到 1.3MB+。实际博客里出现的高亮语言不超过几十种，
 * 这里改用 `PrismLight` 并登记常用语言（含常见别名），体积可下降一半以上。
 *
 * 未登记的语言不会报错，只会退化为无高亮的纯文本代码块。
 */
import { PrismLight } from "react-syntax-highlighter";

import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import clike from "react-syntax-highlighter/dist/esm/languages/prism/clike";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import dart from "react-syntax-highlighter/dist/esm/languages/prism/dart";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import less from "react-syntax-highlighter/dist/esm/languages/prism/less";
import lua from "react-syntax-highlighter/dist/esm/languages/prism/lua";
import makefile from "react-syntax-highlighter/dist/esm/languages/prism/makefile";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import nginx from "react-syntax-highlighter/dist/esm/languages/prism/nginx";
import objectivec from "react-syntax-highlighter/dist/esm/languages/prism/objectivec";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import sass from "react-syntax-highlighter/dist/esm/languages/prism/sass";
import scala from "react-syntax-highlighter/dist/esm/languages/prism/scala";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import solidity from "react-syntax-highlighter/dist/esm/languages/prism/solidity";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

const LANGUAGES: Record<string, Parameters<typeof PrismLight.registerLanguage>[1]> = {
  bash,
  c,
  clike,
  cpp,
  csharp,
  css,
  dart,
  diff,
  docker,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  jsx,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  markup,
  nginx,
  objectivec,
  php,
  powershell,
  python,
  ruby,
  rust,
  sass,
  scala,
  scss,
  solidity,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  PrismLight.registerLanguage(name, definition);
}

// Markdown 代码块里常见的别名 / 变体写法，统一映射到已注册的语言。
const ALIASES: Array<[string, string]> = [
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["console", "bash"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["ts", "typescript"],
  ["jsx", "jsx"],
  ["html", "markup"],
  ["xml", "markup"],
  ["svg", "markup"],
  ["vue", "markup"],
  ["yml", "yaml"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["kt", "kotlin"],
  ["cs", "csharp"],
  ["c++", "cpp"],
  ["hpp", "cpp"],
  ["objc", "objectivec"],
  ["golang", "go"],
  ["ps1", "powershell"],
  ["dockerfile", "docker"],
  ["conf", "ini"],
  ["properties", "ini"],
  ["gql", "graphql"],
];

for (const [alias, target] of ALIASES) {
  const definition = LANGUAGES[target];
  if (definition) {
    PrismLight.registerLanguage(alias, definition);
  }
}

export const SyntaxHighlighter = PrismLight;
