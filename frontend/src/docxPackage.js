const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const DOCUMENT_PATH = "word/document.xml";

export function nameUnnamedPictures(xml) {
  let count = 0;
  const named = xml
    .replace(/<wp:docPr\b([^>]*?)\bname=""/g, (_, attrs) => {
      count += 1;
      return `<wp:docPr${attrs}name="Picture ${count}"`;
    })
    .replace(/<pic:cNvPr\b([^>]*?)\bname=""/g, '<pic:cNvPr$1name="Picture"');
  return { xml: named, count };
}

/**
 * Makes a generated DOCX package acceptable to stricter readers such as Word for Mac:
 * [Content_Types].xml first, no directory entries, and non-empty picture names.
 * @param {Blob} docxBlob
 * @returns {Promise<Blob>}
 */
export async function normalizeDocxPackage(docxBlob) {
  const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");
  const source = unzipSync(new Uint8Array(await docxBlob.arrayBuffer()));
  const paths = Object.keys(source).filter((path) => !path.endsWith("/"));
  const directories = Object.keys(source).length - paths.length;

  const files = {};
  if (source[CONTENT_TYPES_PATH]) files[CONTENT_TYPES_PATH] = source[CONTENT_TYPES_PATH];
  for (const path of paths) {
    if (path !== CONTENT_TYPES_PATH) files[path] = source[path];
  }

  let namedPictures = 0;
  if (files[DOCUMENT_PATH]) {
    const { xml, count } = nameUnnamedPictures(strFromU8(files[DOCUMENT_PATH]));
    namedPictures = count;
    files[DOCUMENT_PATH] = strToU8(xml);
  }

  console.info(
    `docx package normalized: ${paths.length} parts, ${directories} directory entries dropped, ${namedPictures} pictures named`,
  );
  return new Blob([zipSync(files)], { type: DOCX_MIME });
}
