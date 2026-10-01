const mathFunctions = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot", "log", "ln", "sqrt", "lim",
  "max", "min", "det", "gcd", "lcm", "sum", "int"
]);

const mathPunctuation = new Set([
  "(", "^", "_", "=", "+", "-", "*", "/", "<", ">",
]);

const apostrophes = new Set(["'", "’"]);

const mathWords = new Set([
  "pi", "sigma", "theta", "alpha", "beta", "gamma", "delta", "phi", "lambda", "oo" //oo = infinity
]);

const differentialVariables = new Set([
  "x", "y", "z", "t", "u", "v", "r", "s",
]);

const textPunctuation = new Set([".", ";", ":", "!", "?"]);

function isDecimalPoint(text, index) {
  return text[index] === "."
    && /\p{N}/u.test(text[index - 1] || "")
    && /\p{N}/u.test(text[index + 1] || "");
}

function isUrlLike(value) {
  const hasExplicitProtocol = /^https?:\/\//iu.test(value);
  const isBareDomain =
    /^(?:[\p{L}\p{N}-]+\.)+[\p{L}][\p{L}\p{N}-]*(?:[/:?#][^\s]*)?$/u
      .test(value);

  if (!hasExplicitProtocol && !isBareDomain) {
    return false;
  }

  const candidate = hasExplicitProtocol ? value : `https://${value}`;

  try {
    const url = new URL(candidate);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isEmailLike(value) {
  return /^[^\s@]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}][\p{L}\p{N}-]*$/u.test(value);
}

function findPhonePiece(text, index) {
  const phoneMatch = text
    .slice(index)
    .match(/^(?:\+\d{1,2}\s)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\p{L}\p{N}])/u);

  if (!phoneMatch) {
    return null;
  }

  return {
    start: index,
    end: index + phoneMatch[0].length,
    text: phoneMatch[0],
    kind: "phone",
  };
}

function findMarkupPiece(text, index) {
  const match = text.slice(index).match(
    /^<\/?[\p{L}][\p{L}\p{N}:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^"'<>])*)?\/?>/u,
  );
  if (!match) return null;
  return { start: index, end: index + match[0].length, text: match[0], kind: "markup" };
}

function findTextLinkPiece(text, index) {
  const candidateMatch = text.slice(index).match(/^[^\s<>"']+/u);

  if (!candidateMatch) {
    return null;
  }

  const candidate = candidateMatch[0].replace(/[.,;:!?)\]}]+$/u, "");

  if (!candidate || (!isUrlLike(candidate) && !isEmailLike(candidate))) {
    return null;
  }

  return {
    start: index,
    end: index + candidate.length,
    text: candidate,
    kind: "link",
  };
}

function findProtectedPieces(text) {
  const pieces = [];
  let index = 1;

  while (index < text.length) {
    const previousCharacter = text[index - 1];
    const protectedTextPiece =
      findMarkupPiece(text, index) || findTextLinkPiece(text, index) || findPhonePiece(text, index);

    if (
      protectedTextPiece &&
      !/[\p{L}\p{N}@._-]/u.test(previousCharacter)
    ) {
      pieces.push(protectedTextPiece);
      index = protectedTextPiece.end;
      continue;
    }

    const validBoundary =
      /\s/u.test(previousCharacter) ||
      mathPunctuation.has(previousCharacter);

    if (!validBoundary) {
      index += 1;
      continue;
    }

    const remainder = text.slice(index);
    const functionMatch = remainder.match(/^(\p{L}+)(.)/u);

    if (
      functionMatch &&
      mathFunctions.has(functionMatch[1].toLowerCase()) &&
      mathPunctuation.has(functionMatch[2])
    ) {
      const pieceText = functionMatch[1] + functionMatch[2];
      pieces.push({
        start: index,
        end: index + pieceText.length,
        text: pieceText,
        kind: "function",
      });
      index += pieceText.length;
      continue;
    }

    const letter = text[index];
    const punctuation = text[index + 1];
    const afterPunctuation = text[index + 2];

    if (
      letter &&
      apostrophes.has(punctuation) &&
      /^\p{L}$/u.test(letter) &&
      (
        !afterPunctuation ||
        /\s/u.test(afterPunctuation) ||
        mathPunctuation.has(afterPunctuation)
      )
    ) {
      pieces.push({
        start: index,
        end: index + 2,
        text: `${letter}'`,
        kind: "apostrophe",
      });
      index += 2;
      continue;
    }

    if (
      letter &&
      punctuation &&
      /^\p{L}$/u.test(letter) &&
      mathPunctuation.has(punctuation)
    ) {
      pieces.push({
        start: index,
        end: index + 2,
        text: letter + punctuation,
        kind: "punctuation",
      });
      index += 2;
      continue;
    }

    index += 1;
  }

  return pieces;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function randomNamespace() {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0].toString(10);
  }
  return String(Math.floor(Math.random() * 1e9));
}

function confidenceForRange(text, range) {
  const candidate = text.slice(range.start, range.end).trim();
  const normalizedCandidate = candidate.toLowerCase();
  const functionName = normalizedCandidate.match(/^(\p{L}+)\s*\(/u)?.[1];
  const isDifferential =
    candidate.length === 2 &&
    candidate[0] === "d" &&
    differentialVariables.has(candidate[1].toLowerCase());
  const isDerivative = /^\p{L}['’](?:\(|$)/u.test(candidate);

  if (mathWords.has(normalizedCandidate)) {
    return { confidence: "definite", reason: "math-word" };
  }
  if (isDifferential) {
    return { confidence: "definite", reason: "differential" };
  }
  if (functionName && mathFunctions.has(functionName)) {
    return { confidence: "definite", reason: "math-function" };
  }
  if (isDerivative) {
    return { confidence: "definite", reason: "derivative" };
  }
  if (/[=^_+*/<>]/u.test(candidate)) {
    return { confidence: "definite", reason: "math-operator" };
  }
  return { confidence: "potential", reason: "context-dependent" };
}

/** Classify plain text into math tokens and merged run ranges. */
export function classifyMath(text) {
  const analysisText = ` ${text}`;
  const placeholderNamespace = randomNamespace();
  const protectedPieces = findProtectedPieces(analysisText);

  let protectedStream = "";
  let cursor = 0;

  protectedPieces.forEach((piece, index) => {
    protectedStream += analysisText.slice(cursor, piece.start);
    protectedStream += ` ${placeholderNamespace}MATHTOKEN${index} `;
    cursor = piece.end;
  });

  protectedStream += analysisText.slice(cursor);

  let textPunctuationIndex = 0;

  const punctuationReplaced = [...protectedStream]
    .map((character, index) => {
      if (isDecimalPoint(protectedStream, index)) return character;
      if (/[\p{L}\p{N}\s]/u.test(character)) {
        return character;
      }

      if (textPunctuation.has(character)) {
        const placeholder =
          ` ${placeholderNamespace}TEXTPUNCT${textPunctuationIndex} `;
        textPunctuationIndex += 1;
        return placeholder;
      }

      if (apostrophes.has(character) || character === '"') {
        return character;
      }

      return " ";
    })
    .join("");

  const finalTokenComplete =
    /\s$/u.test(punctuationReplaced) ||
    new RegExp(`${placeholderNamespace}TEXTPUNCT\\d+\\s*$`, "u")
      .test(punctuationReplaced);

  const normalized = punctuationReplaced
    .replace(/\s+/gu, " ")
    .trim();

  const rawTokens = normalized ? normalized.split(" ") : [];

  const tokens = rawTokens.map((token, index) => {
    const isLastToken = index === rawTokens.length - 1;
    const incomplete = isLastToken && !finalTokenComplete;
    const textPunctuationMatch = token.match(
      new RegExp(`^${placeholderNamespace}TEXTPUNCT(\\d+)$`, "u"),
    );

    if (textPunctuationMatch) {
      return {
        text: [...protectedStream].filter((character) => textPunctuation.has(character))[
          Number(textPunctuationMatch[1])
        ],
        kind: "text-punctuation",
        math: false,
        protected: false,
        incomplete: false,
        breaksMathRun: true,
      };
    }

    const protectedMatch = token.match(
      new RegExp(`^${placeholderNamespace}MATHTOKEN(\\d+)$`, "u"),
    );

    if (protectedMatch) {
      const protectedPiece =
        protectedPieces[Number(protectedMatch[1])];

      return {
        text: protectedPiece.text,
        kind: protectedPiece.kind,
        math: protectedPiece.kind !== "markup" && !incomplete,
        protected: true,
        incomplete,
        breaksMathRun: protectedPiece.kind === "markup",
      };
    }

    const normalizedToken = token.toLowerCase();
    const isMathWord = mathWords.has(normalizedToken);
    const isDifferential =
      token.length === 2 &&
      token[0] === "d" &&
      differentialVariables.has(token[1].toLowerCase());
    const isNumber = /^\p{N}+(?:\.\p{N}+)?$/u.test(token);
    const isSingleLetter = /^\p{L}$/u.test(token);

    const isMathLetter =
      isSingleLetter &&
      normalizedToken !== "a" &&
      normalizedToken !== "i";

    const normallyMath =
      isMathWord ||
      isDifferential ||
      isNumber ||
      isMathLetter;

    return {
      text: token,
      kind: "ordinary",
      math: incomplete ? false : normallyMath,
      protected: false,
      incomplete,
      breaksMathRun: false,
    };
  });

  const runs = [];
  let currentRun = [];

  for (const token of tokens) {
    if (token.math) {
      currentRun.push(token);
      continue;
    }

    if (currentRun.length > 0) {
      runs.push(currentRun);
      currentRun = [];
    }
  }

  if (currentRun.length > 0) {
    runs.push(currentRun);
  }

  const filteredRuns = runs.filter((run) => {
    if (run.length !== 1) {
      return true;
    }

    const tokenText = run[0].text;
    const normalizedToken = tokenText.toLowerCase();

    if (mathWords.has(normalizedToken)) {
      return true;
    }

    const isDifferential =
      tokenText.length === 2 &&
      tokenText[0] === "d" &&
      differentialVariables.has(tokenText[1].toLowerCase());

    if (isDifferential) {
      return true;
    }

    const isSingleLetter = /^\p{L}$/u.test(tokenText);
    const canBeWordOnItsOwn =
      normalizedToken === "a" ||
      normalizedToken === "i";

    return isSingleLetter && !canBeWordOnItsOwn;
  });

  let searchCursor = 0;

  for (const token of tokens) {
    const sourceStart = text.indexOf(token.text, searchCursor);

    if (sourceStart === -1) {
      token.sourceStart = null;
      token.sourceEnd = null;
      continue;
    }

    token.sourceStart = sourceStart;
    token.sourceEnd = sourceStart + token.text.length;
    searchCursor = token.sourceEnd;
  }

  const runRanges = filteredRuns
    .map((run) => ({
      start: run[0].sourceStart,
      end: run[run.length - 1].sourceEnd,
    }))
    .filter((range) => range.start !== null && range.end !== null)
    .map((range) => {
      let start = range.start;
      let end = range.end;

      while (
        start > 0 &&
        !/\s/u.test(text[start - 1]) &&
        (!textPunctuation.has(text[start - 1]) || isDecimalPoint(text, start - 1))
      ) {
        start -= 1;
      }

      while (
        end < text.length &&
        !/\s/u.test(text[end]) &&
        (!textPunctuation.has(text[end]) || isDecimalPoint(text, end))
      ) {
        end += 1;
      }

      return { start, end };
    });

  const mergedRunRanges = [];

  for (const range of runRanges) {
    const previousRange = mergedRunRanges[mergedRunRanges.length - 1];

    if (previousRange && range.start <= previousRange.end) {
      previousRange.end = Math.max(previousRange.end, range.end);
      continue;
    }

    mergedRunRanges.push({ start: range.start, end: range.end });
  }

  let resultHtml = "";
  let htmlCursor = 0;

  for (const range of mergedRunRanges) {
    resultHtml += escapeHtml(text.slice(htmlCursor, range.start));
    resultHtml += `<span class="render-latex">${escapeHtml(
      text.slice(range.start, range.end),
    )}</span>`;
    htmlCursor = range.end;
  }

  resultHtml += escapeHtml(text.slice(htmlCursor));
  const candidates = mergedRunRanges.map((range) => ({
    ...range,
    ...confidenceForRange(text, range),
  }));

  return {
    analysisText,
    protectedPieces,
    punctuationReplaced,
    normalized,
    tokens,
    runs: filteredRuns,
    ranges: mergedRunRanges,
    candidates,
    html: resultHtml,
  };
}
