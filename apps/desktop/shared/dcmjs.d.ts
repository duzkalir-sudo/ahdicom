/** Minimal typing for the part of dcmjs used by the main process (data dictionary lookup). */
declare module 'dcmjs' {
  interface DictionaryEntry {
    tag: string;
    vr: string;
    vm: string;
    name: string;
  }
  const dcmjs: {
    data: { DicomMetaDictionary: { dictionary: Record<string, DictionaryEntry | undefined> } };
    log: { getLogger(name: string): { setLevel(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'): void } };
  };
  export default dcmjs;
}
