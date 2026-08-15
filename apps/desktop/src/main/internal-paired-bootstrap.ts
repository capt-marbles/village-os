export class InternalPairedBootstrap<Provisioned, Coordination> {
  private provisioning: Promise<Provisioned> | undefined;
  private composition:
    | Promise<{ provisioned: Provisioned; coordination: Coordination }>
    | undefined;

  constructor(
    private readonly provision: () => Promise<Provisioned>,
    private readonly compose: (
      provisioned: Provisioned,
    ) => Promise<Coordination>,
  ) {}

  result(): Promise<{ provisioned: Provisioned; coordination: Coordination }> {
    if (!this.provisioning) {
      const provisioning = this.provision().catch((error: unknown) => {
        if (this.provisioning === provisioning) this.provisioning = undefined;
        throw error;
      });
      this.provisioning = provisioning;
    }
    if (!this.composition) {
      const composition = this.provisioning
        .then(async (provisioned) => ({
          provisioned,
          coordination: await this.compose(provisioned),
        }))
        .catch((error: unknown) => {
          if (this.composition === composition) this.composition = undefined;
          throw error;
        });
      this.composition = composition;
    }
    return this.composition;
  }
}
