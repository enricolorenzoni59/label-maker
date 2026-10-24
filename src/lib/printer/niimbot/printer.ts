import {
  ImageEncoder,
  LabelType,
  NiimbotBluetoothClient,
  PageColorType,
  type ImageSource,
  type NiimbotAbstractClient,
} from '@mmote/niimbluelib';
import { getPixel, type LabelBitmap } from '@mbtech-nl/bitmap';
import {
  WriteSerializer,
  type DeviceEntry,
  type MediaDescriptor,
  type PreviewOptions,
  type PreviewResult,
  type PrinterAdapter,
  type PrinterError,
  type PrinterStatus,
  type PrintOptions,
  type RawImageData,
  type StatusDetail,
} from '@thermal-label/contracts';

import { DEFAULT_MEDIA, MEDIA, findDeviceByModel, findMediaBySize } from './devices';
import { rasterizeForHead } from './raster';
import { recallRollMedia, rememberRollMedia } from './roll-memory';

/**
 * The slice of niimbluelib's client the adapter drives. Typed as a
 * `Pick` so tests can hand in a fake without a Bluetooth stack.
 */
export type NiimbotClient = Pick<
  NiimbotAbstractClient,
  | 'protocol'
  | 'isConnected'
  | 'disconnect'
  | 'getModelMetadata'
  | 'getPrintTaskType'
  | 'getPrinterInfo'
  | 'getRfidInfo'
  | 'getHeartbeatData'
  | 'startHeartbeat'
  | 'stopHeartbeat'
  | 'on'
  | 'off'
>;

/** Wraps a head-orientation bitmap for niimbluelib's encoder (`printDirection: 'top'` = no rotation). */
class BitmapImageSource implements ImageSource {
  constructor(private readonly bitmap: LabelBitmap) {}

  get width(): number {
    return this.bitmap.widthPx;
  }

  get height(): number {
    return this.bitmap.heightPx;
  }

  getPixelColor(x: number, y: number): number {
    return getPixel(this.bitmap, x, y) ? 0x000000 : 0xffffff;
  }
}

/**
 * Browser driver for Niimbot label printers over Web Bluetooth.
 *
 * niimbluelib owns the wire protocol: packet framing, the per-model
 * print task (D110 vs B1 / D110M_V4 sequences), and the heartbeat that
 * keeps the BLE link alive and reports lid / paper / battery state.
 * This class adapts it to `PrinterAdapter`: rasterising the design for
 * the 96-dot head, mapping density / copies, and turning heartbeat
 * data into `PrinterStatus`.
 *
 * `getStatus()` never touches the wire — it reports the last heartbeat,
 * which niimbluelib refreshes on its own timer. The heartbeat is
 * stopped for the duration of a print so its packets can't interleave
 * with the job's.
 */
export class WebNiimbotPrinter implements PrinterAdapter {
  readonly family = 'niimbot';
  readonly device: DeviceEntry;
  private readonly client: NiimbotClient;
  private readonly serializer = new WriteSerializer();

  constructor(device: DeviceEntry, client: NiimbotClient) {
    this.device = device;
    this.client = client;
  }

  get model(): string {
    return this.device.name;
  }

  get connected(): boolean {
    return this.client.isConnected();
  }

  print(image: RawImageData, media?: MediaDescriptor, options?: PrintOptions): Promise<void> {
    return this.serializer.run(() => this.doPrint(image, media, options));
  }

  private async doPrint(
    image: RawImageData,
    media: MediaDescriptor | undefined,
    options: PrintOptions | undefined,
  ): Promise<void> {
    const { head } = rasterizeForHead(image, this.engine(), media ?? this.detectedMedia());
    const encoded = ImageEncoder.encode(
      new BitmapImageSource(head),
      PageColorType.SingleColor,
      'top',
    );
    const copies = Math.max(1, options?.copies ?? 1);
    const task = this.client.protocol.newPrintTask(this.client.getPrintTaskType() ?? 'D110', {
      totalPages: copies,
      density: this.density(options?.density),
      labelType: LabelType.WithGaps,
      // Same pacing niimblue uses; the library defaults poll slower.
      statusPollIntervalMs: 100,
      statusTimeoutMs: 8_000,
    });

    this.client.stopHeartbeat();
    try {
      await task.printInit();
      await task.printPage(encoded, copies);
      await task.waitForPageFinished();
      await task.waitForFinished();
      this.learnRoll(media);
    } finally {
      try {
        // The task's own printEnd — D110M_V4 follows PrintEnd with a heartbeat the firmware expects.
        await task.printEnd();
      } catch (err) {
        console.warn('[burnmark] niimbot printEnd failed', err);
      }
      if (this.client.isConnected()) this.client.startHeartbeat();
    }
  }

  createPreview(image: RawImageData, options?: PreviewOptions): Promise<PreviewResult> {
    const media = options?.media ?? this.detectedMedia();
    const { visual } = rasterizeForHead(image, this.engine(), media ?? DEFAULT_MEDIA);
    return Promise.resolve({
      planes: [{ name: 'black', bitmap: visual, displayColor: '#000000' }],
      media: media ?? DEFAULT_MEDIA,
      assumed: !media,
    });
  }

  getStatus(): Promise<PrinterStatus> {
    return Promise.resolve(this.buildStatus());
  }

  onStatus(cb: (status: PrinterStatus) => void): () => void {
    const emit = (): void => cb(this.buildStatus());
    this.client.on('heartbeat', emit);
    this.client.on('rfidinfofetched', emit);
    this.client.on('disconnect', emit);
    return () => {
      this.client.off('heartbeat', emit);
      this.client.off('rfidinfofetched', emit);
      this.client.off('disconnect', emit);
    };
  }

  async close(): Promise<void> {
    await this.client.disconnect();
  }

  private engine(): DeviceEntry['engines'][number] {
    const [engine] = this.device.engines;
    if (!engine) throw new Error(`Device ${this.device.key} has no print engines`);
    return engine;
  }

  /** `light` / `normal` / `dark` → the model's density range (D110: 1–3, D110_M: 1–5). */
  private density(level: string | undefined): number {
    const meta = this.client.getModelMetadata();
    const min = meta?.densityMin ?? 1;
    const max = meta?.densityMax ?? 3;
    const def = meta?.densityDefault ?? 2;
    if (level === 'light') return min;
    if (level === 'dark') return max;
    return def;
  }

  /**
   * Media for the loaded roll: the printer's own paper-info dimensions
   * when the firmware reports them (newer models), otherwise whatever a
   * previous print on a roll with the same RFID barcode used (D110 —
   * see `./roll-memory.ts`).
   */
  private detectedMedia(): MediaDescriptor | undefined {
    const { paperInfo, labelRfidInfo } = this.client.getRfidInfo();
    if (paperInfo?.valid && paperInfo.paperWidth && paperInfo.paperHeight) {
      const bySize = findMediaBySize(paperInfo.paperWidth, paperInfo.paperHeight);
      if (bySize) return bySize;
    }
    if (labelRfidInfo?.tagPresent && labelRfidInfo.barCode) {
      const id = recallRollMedia(labelRfidInfo.barCode);
      if (id) return MEDIA[id];
    }
    return undefined;
  }

  /** After a successful print on a tagged roll, remember which registry media it was. */
  private learnRoll(media: MediaDescriptor | undefined): void {
    const tag = this.client.getRfidInfo().labelRfidInfo;
    if (!media || !tag?.tagPresent || !tag.barCode) return;
    // By id, not identity — the store hands media through Vue reactive proxies.
    if (!MEDIA[String(media.id)]) return;
    rememberRollMedia(tag.barCode, String(media.id));
  }

  private buildStatus(): PrinterStatus {
    const connected = this.client.isConnected();
    const hb = this.client.getHeartbeatData();
    const info = this.client.getPrinterInfo();
    const errors: PrinterError[] = [];
    if (connected && hb.lidClosed === false) {
      errors.push({ code: 'cover_open', message: 'The printer lid is open.' });
    }
    if (connected && hb.paperInserted === false) {
      errors.push({ code: 'no_media', message: 'No label roll is loaded.' });
    }

    const details: StatusDetail[] = [];
    if (info.softwareVersion) details.push({ label: 'Firmware', value: info.softwareVersion });
    if (info.hardwareVersion) details.push({ label: 'Hardware', value: info.hardwareVersion });
    if (info.serial) details.push({ label: 'Serial', value: info.serial });
    const tag = this.client.getRfidInfo().labelRfidInfo;
    if (tag?.tagPresent) {
      details.push({
        label: 'Roll',
        value: `${tag.allPaper - tag.usedPaper}/${tag.allPaper} left`,
      });
      details.push({ label: 'Roll barcode', value: tag.barCode });
    } else {
      details.push({ label: 'Roll', value: 'no RFID tag read' });
    }

    const battery = hb.batteryPercents ?? info.batteryPercents;
    return {
      ready: connected && errors.length === 0,
      mediaLoaded: hb.paperInserted ?? true,
      detectedMedia: this.detectedMedia(),
      errors,
      rawBytes: new Uint8Array(0),
      details,
      ...(battery !== undefined ? { battery: { fraction: battery / 100 } } : {}),
    };
  }
}

/**
 * Show the Web Bluetooth picker (filtered to Niimbot name prefixes and
 * service), connect, and identify the model from the printer's own
 * model id. User-gesture required.
 *
 * Throws for models not in our registry yet so the user gets a clear
 * message instead of a misprint with the wrong head width.
 */
export async function requestNiimbotBluetooth(): Promise<WebNiimbotPrinter> {
  const client = new NiimbotBluetoothClient();
  await client.connect();
  const meta = client.getModelMetadata();
  const device = findDeviceByModel(meta?.model);
  if (!device) {
    await client.disconnect();
    throw new Error(
      `Niimbot ${meta?.model ?? `model id ${client.getPrinterInfo().modelId ?? '?'}`} is not supported yet (supported: D110, D110_M)`,
    );
  }
  // Firmware that doesn't report roll dimensions falls back to roll
  // memory; log what it did report so detection gaps can be diagnosed.
  const rfid = client.getRfidInfo();
  if (!rfid.paperInfo?.valid) {
    console.warn('[burnmark] niimbot: roll size not reported by printer', {
      model: meta?.model,
      firmware: client.getPrinterInfo().softwareVersion,
      rfid,
    });
  }
  return new WebNiimbotPrinter(device, client);
}
