import * as FS from 'fs';
import * as Console from 'console';
import { promisify } from 'util';
import * as Esprima from 'esprima';
import * as ESTree from 'estree';
import * as terser from 'terser';
import {
  BasicSourceMapConsumer,
  IndexedSourceMapConsumer,
  SourceMapConsumer,
} from 'source-map';

function* yieldElmJsDefinitionInfos(script: Esprima.Program) {
  for (const statement of yieldElmJsStatements(script)) {
    yield* yieldFunctionDeclarationInfo(statement);
    yield* yieldVariableDeclarationInfos(statement);
  }
}

function* yieldElmJsStatements(script: Esprima.Program) {
  for (const e of script.body) {
    if (e.type === 'ExpressionStatement'
        && e.expression.type === 'CallExpression'
        && e.expression.callee.type === 'FunctionExpression') {
        yield* e.expression.callee.body.body;
    }
};
}

function* yieldFunctionDeclarationInfo(statement: ESTree.Statement) {
  if (statement.type === 'FunctionDeclaration') {
    yield {
      name: statement.id.name,
      range: statement.range
    };
  }
}

function* yieldVariableDeclarationInfos(statement: ESTree.Statement) {
  if (statement.type === 'VariableDeclaration') {
    for (const declaration of statement.declarations) {
      if (declaration.id.type === 'Identifier') {
        yield {
          name: declaration.id.name,
          range: declaration.range
        };
      }
    }
  }
}

function rangeSize([start, end]: [number, number]) {
  return end - start;
}

function percentage(value: number, of: number) {
  return `${Number((value / of) * 100).toFixed(3)}%`;
}

async function withTerser<T>(
  filePath: string,
  callback: (
    compressedCode: string,
    consumer: BasicSourceMapConsumer | IndexedSourceMapConsumer
  ) => T
): Promise<T> {
  Console.log('Running terser');
  const file = await promisify(FS.readFile)(filePath);
  const source = file.toString();
  const minifiedElm = await terser.minify(source, {
    ecma: 5,

    module: true,
    compress: {
      pure_funcs: [
        // "F2",
        // "F3",
        // "F4",
        // "F5",
        // "F6",
        // "F7",
        // "F8",
        // "F9",
        // "A2",
        // "A3",
        // "A4",
        // "A5",
        // "A6",
        // "A7",
        // "A8",
        // "A9",
      ],
      pure_getters: true,
      keep_fargs: false,
      unsafe_comps: true,
      unsafe: true,
      passes: 2,
    },
    mangle: true,
    sourceMap: true,
  });
  if (minifiedElm.code) {
    await promisify(FS.writeFile)('tersed.js', minifiedElm.code);
    const rawSourceMap = minifiedElm.map as string;
    const result = await SourceMapConsumer.with(
      rawSourceMap,
      null,
      (consumer) => {
        return callback(minifiedElm.code, consumer);
      }
    );
    return result;
  } else {
    throw 'Error running terser.';
  }
}

async function process(
  code: string,
  compressedCode: string | null = null,
  consumer: BasicSourceMapConsumer | IndexedSourceMapConsumer | null = null
) {
  Console.log('Parsing code');
  consumer.computeColumnSpans();

  const parsed = Esprima.parseScript(code, { range: true });
  if (!compressedCode) {
    compressedCode = code;
  }
  const parsedCompressed = Esprima.parseScript(compressedCode, { range: true });
  const compressedSize = rangeSize(parsedCompressed.range);
  const infos = Array.from(yieldElmJsDefinitionInfos(parsed));

  const compressedSplat = compressedCode.split('\n');

  const indexCache = {};

  function indexToLineColumn(index: number) {
    const beforeSlice = code.slice(0, index);
    const splat = beforeSlice.split('\n');
    const line = splat.length; // 1-based
    const column = splat[splat.length - 1].length; // 0-based
    return { line: line, column: column };
  }

  function compressIndex(index: number, left: boolean) {
    if (!consumer) return index;
    if (index in indexCache) {
      return indexCache[index];
    }
    const { line, column } = indexToLineColumn(index);
    const mapped = consumer.generatedPositionFor({
      source: '0',
      line: line,
      column: column,
    });

    let result = mapped.column; // 0-based
    for (
      let lineNumber = 1;
      lineNumber < mapped.line; // 1-based, `<` because we already added the count for the last line
      lineNumber++
    ) {
      result += compressedSplat[lineNumber - 1].length + 1; // The +1 is for the \n
    }

    return (indexCache[index] = result);
  }

  function compressRange({
    name,
    range,
  }: {
    name: string;
    range: [number, number];
  }): [number, number] {
    const result: [number, number] = [
      compressIndex(range[0], true),
      compressIndex(range[1], false),
    ];
    if (rangeSize(result) < 0) {
      Console.log({
        name: name,
        range: range,
        lineColumn: range.map(indexToLineColumn),

        mapped: range.map((index, j) => {
          const left = j == 0;
          const { line, column } = indexToLineColumn(index + (left ? 0 : 1));
          const generated = consumer.generatedPositionFor({
            source: '0',
            line: line,
            column: column,
          });

          return {
            line: line,
            column: column,
            mapped: JSON.stringify(generated),
            remapped: JSON.stringify(consumer.originalPositionFor(generated)),
          };
        }),
        compressed: result,
      });
      throw new Error('Invalid negative range');
      // return [result[1], result[0]];
    } else {
      return result;
    }
  }

  Console.log('Sorting');
  infos.sort((a, b) => {
    const compressedRangeA = compressRange(a);
    const compressedRangeB = compressRange(b);

    return rangeSize(compressedRangeB) - rangeSize(compressedRangeA);
  });
  infos.forEach((item) => {
    const rs = rangeSize(compressRange(item));
    Console.log(`${percentage(rs, compressedSize)}: ${item.name}`);
  });
  const rangeSum = infos
    .map((item) => rangeSize(compressRange(item)))
    .reduce((a, b) => a + b, 0);
  Console.log(
    `Range sum: ${rangeSum} total: ${compressedSize}, analized ${percentage(
      rangeSum,
      compressedSize
    )}`
  );
}

export async function analyse(
  elmOutputJsFilePath: string,
  options: { terser: boolean }
) {
  const file = await promisify(FS.readFile)(elmOutputJsFilePath);
  const code = file.toString();
  if (options.terser) {
    await withTerser(elmOutputJsFilePath, (compressedCode, consumer) =>
      process(code, compressedCode, consumer)
    );
    return;
  }
  await process(code);
}
