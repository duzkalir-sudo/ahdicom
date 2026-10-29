/**
 * Empty stand-in for Node built-ins (fs, path, url) referenced by Emscripten codec glue and vtk.js XML helpers.
 * Those code paths only run under Node; in the renderer they are never executed.
 */
export default {};
