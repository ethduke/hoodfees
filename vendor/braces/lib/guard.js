'use strict';
// Bound recursive consumers even when callers supply an AST directly.
const fail = () => { throw new RangeError('brace nesting limit exceeded'); };
exports.guardPattern = input => {
  if (typeof input !== 'string') return;
  const stack = [], pairs = { '}': '{', ')': '(', ']': '[' };
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue; }
    if ('{(['.includes(input[i])) {
      stack.push(input[i]);
      if (stack.length > 128) fail();
    } else if (pairs[input[i]] === stack[stack.length - 1]) stack.pop();
  }
};
exports.guardAst = ast => {
  const stack = [[ast, 0]], seen = new Set();
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > 128 || ++nodes > 16384 || seen.has(node)) fail();
    seen.add(node);
    if (Array.isArray(node.nodes)) {
      if (node.nodes.length + stack.length > 16384) fail();
      for (const child of node.nodes) stack.push([child, depth + 1]);
    }
  }
};
