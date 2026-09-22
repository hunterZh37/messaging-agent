export interface Entry {
  status: string;
  path: string;
  from?: string;
}
export interface Manifest {
  name: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
export declare const DIAGRAM_JSON: string;
export declare function drift(entries: Entry[], manifests?: Manifest[]): { touched: boolean; reasons: string[] };
export declare function dependencyChanges(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[];
export declare function parseNameStatus(text: string): Entry[];
export declare function parseNameStatusZ(text: string): Entry[];
