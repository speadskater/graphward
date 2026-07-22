export const localValue = 1;
const internalValue = 2;
export { internalValue as publicValue };
export { remoteValue as renamedRemote, type RemoteShape } from "./remote.js";
export * from "./everything.js";
export * as helpers from "./helpers.js";

export interface Runnable<T> extends Parent<T>, contracts.Named {
  run(input: Input): Promise<Result<T>>;
}

export class Runner<T extends Input = DefaultInput>
  extends BaseRunner<T>
  implements Runnable<T>, contracts.Disposable {
  constructor(private readonly worker: Worker) {
    super();
  }

  run(input: Input): Promise<Result<T>> {
    return this.worker.run(input);
  }
}

type Box<T> = Readonly<Result<T>> & contracts.Container;
export default Runner;
