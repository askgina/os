import {
  ApiError,
  DeviceLabel,
  type NotificationDetail,
  type NotificationPreferences,
  type PushSubscriptionSummary,
  type QuietHours,
  type WorkspaceDetail,
  type WorkspaceNotifications,
} from "@askgina/os-api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, BellOff, Smartphone, Trash2 } from "lucide-react";
import { type SubmitEvent, useId, useState } from "react";
import { ErrorState, FormError, Loading } from "@/components/common.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Choice } from "@/components/ui/choice.tsx";
import { Input, Select } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  api,
  keys,
  queryClient,
  useNotificationPreferences,
  usePushConfig,
  usePushDevices,
  useWorkspaces,
} from "@/lib/api.ts";
import { explainNotificationError } from "@/lib/codes.ts";
import { formatTime } from "@/lib/format.ts";
import {
  browserSubscription,
  type DeviceState,
  deviceState,
  type PushSupport,
  pushSupport,
  readDeviceRecord,
  type StoppedReason,
  subscribeThisBrowser,
  suggestDeviceLabel,
  unsubscribeThisBrowser,
  writeDeviceRecord,
} from "@/lib/push.ts";
import {
  describeQuietHours,
  parseQuietHours,
  type QuietHoursForm,
  type QuietHoursProblem,
  quietHoursForm,
  timeZoneChoices,
} from "@/lib/quiet-hours.ts";

/** Refusals after which the server will never send to this browser's subscription. */
const DEVICE_REFUSED: Record<string, true> = {
  push_off: true,
  endpoint_refused: true,
  bad_subscription: true,
};

/** Removes one of the person's devices; one already gone counts as removed. */
async function removeDevice(subscriptionId: string): Promise<void> {
  try {
    await api.call("removePushSubscription", { params: { subscriptionId } });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "not_found")) throw error;
  }
}

/** Every query about devices: the server's list and this browser's own subscription. */
const refreshDevices = () => queryClient.invalidateQueries({ queryKey: ["push"] });

/**
 * The settings page's notifications: this device, the person's devices, a switch per workspace
 * and quiet hours. While the server does not send Web Push, only that, and the other way to hear
 * about requests: the operator's webhook.
 */
export function NotificationSettings({ userId }: { userId: string }) {
  const config = usePushConfig();
  return (
    <Card aria-labelledby="notifications-title">
      <CardHeader>
        <div>
          <CardTitle id="notifications-title">Notifications</CardTitle>
          <CardDescription>
            A notification tells you that a request waits for your passkey and opens it when you
            press it. It says how many requests wait, and, where a workspace's owner allows it, the
            kind of request, who asked and the workspace's name. Never an amount or a recipient:
            those stay on the approval page.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6">
        {config.isPending ? <Loading /> : null}
        {config.isError ? (
          <ErrorState error={config.error} retry={() => void config.refetch()} />
        ) : null}
        {config.data && config.data.applicationServerKey === null ? <PushOff /> : null}
        {config.data?.applicationServerKey ? (
          <PushOn userId={userId} serverKey={config.data.applicationServerKey} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function PushOff() {
  return (
    <Alert className="items-start">
      <BellOff aria-hidden />
      <div className="grid grid-cols-1 gap-2">
        <p className="font-medium">
          This server does not send notifications to phones or browsers.
        </p>
        <p className="text-muted-foreground">
          Its operator has not turned them on: each one would pass, encrypted, through the push
          service of your browser's maker (Google, Apple, Mozilla or Microsoft). Requests still wait
          for you in each workspace's approval inbox.
        </p>
        <p className="text-muted-foreground">
          The operator can instead have the server announce every waiting request to an address of
          their own (its webhook) and pass it on from there, for example to a chat or to the ntfy
          app on your phone. Ask them whether they have.
        </p>
      </div>
    </Alert>
  );
}

function PushOn({ userId, serverKey }: { userId: string; serverKey: string }) {
  const devices = usePushDevices();
  const preferences = useNotificationPreferences();
  // Read again after asking for permission: the answer can block notifications for good.
  const [support, setSupport] = useState<PushSupport>(() => pushSupport());
  const local = useQuery({
    queryKey: keys.thisBrowser,
    queryFn: async () => ({ browser: await browserSubscription(), record: readDeviceRecord() }),
    enabled: support === "available",
  });
  const state: DeviceState | null =
    devices.data && (local.data || support !== "available")
      ? deviceState({
          userId,
          record: local.data?.record ?? null,
          browser: local.data?.browser ?? null,
          serverKey,
          devices: devices.data.items,
        })
      : null;
  const thisDeviceId = state && state.kind !== "off" ? state.subscriptionId : null;

  return (
    <>
      <section aria-labelledby="this-device-title" className="grid grid-cols-1 gap-3">
        <h3 id="this-device-title" className="text-sm font-semibold">
          This device
        </h3>
        <ThisDevice
          support={support}
          state={state}
          userId={userId}
          serverKey={serverKey}
          onAsked={() => setSupport(pushSupport())}
        />
      </section>

      <section aria-labelledby="devices-title" className="grid grid-cols-1 gap-3">
        <h3 id="devices-title" className="text-sm font-semibold">
          Your devices
        </h3>
        {devices.isPending ? <Loading /> : null}
        {devices.isError ? (
          <ErrorState error={devices.error} retry={() => void devices.refetch()} />
        ) : null}
        {devices.data && devices.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No device of yours gets notifications.</p>
        ) : null}
        {devices.data && devices.data.items.length > 0 ? (
          <ul aria-labelledby="devices-title" className="divide-y rounded-md border">
            {devices.data.items.map((device) => (
              <DeviceRow key={device.id} device={device} isThis={device.id === thisDeviceId} />
            ))}
          </ul>
        ) : null}
      </section>

      {preferences.isPending ? <Loading /> : null}
      {preferences.isError ? (
        <ErrorState error={preferences.error} retry={() => void preferences.refetch()} />
      ) : null}
      {preferences.data ? (
        <>
          <WorkspaceSwitches preferences={preferences.data} />
          <QuietHoursEditor saved={preferences.data.quietHours} />
        </>
      ) : null}
    </>
  );
}

const STOPPED: Record<StoppedReason, string> = {
  ended:
    "This browser no longer has its subscription: notifications were blocked, the site's data was cleared, or the browser let it run out.",
  replaced: "This browser replaced its subscription with one the server does not know.",
  "key-changed":
    "The server's notification key changed, and a subscription works only with the key it was made with.",
  removed:
    "It was removed from your devices, here or on another device, or its push service said it was gone.",
};

function ThisDevice({
  support,
  state,
  userId,
  serverKey,
  onAsked,
}: {
  support: PushSupport;
  state: DeviceState | null;
  userId: string;
  serverKey: string;
  onAsked: () => void;
}) {
  const labelId = useId();
  const [label, setLabel] = useState(() =>
    suggestDeviceLabel(navigator.userAgent, navigator.maxTouchPoints),
  );
  const [labelProblem, setLabelProblem] = useState<string | null>(null);
  const enable = useMutation({
    mutationFn: async (permission: Promise<NotificationPermission>) => {
      const record = readDeviceRecord();
      const body = await subscribeThisBrowser({
        permission,
        applicationServerKey: serverKey,
        label: label.trim() === "" ? undefined : label.trim(),
      });
      let saved: PushSubscriptionSummary;
      try {
        saved = await api.call("addPushSubscription", { body });
      } catch (error) {
        // A subscription the server will never send to is of no use to the browser either.
        if (error instanceof ApiError && Object.hasOwn(DEVICE_REFUSED, error.detail ?? "")) {
          await unsubscribeThisBrowser();
        }
        throw error;
      }
      writeDeviceRecord({ userId, subscriptionId: saved.id, endpoint: body.endpoint });
      // The device this browser was before (a replaced subscription) reaches nobody any more.
      if (record?.userId === userId && record.subscriptionId !== saved.id) {
        await removeDevice(record.subscriptionId);
      }
      return saved;
    },
    onSettled: async () => {
      onAsked();
      await refreshDevices();
    },
  });
  const disable = useMutation({
    mutationFn: async (subscriptionId: string) => {
      await removeDevice(subscriptionId);
      await unsubscribeThisBrowser();
    },
    onSettled: refreshDevices,
  });

  if (support === "unsupported") {
    return (
      <Alert className="items-start">
        <BellOff aria-hidden />
        <p>
          This browser cannot get notifications from websites. A current Chrome, Edge, Firefox or
          Safari can, on this site's HTTPS address; on an iPhone or iPad, iOS 16.4 or later is
          needed.
        </p>
      </Alert>
    );
  }
  if (support === "needs-install") {
    return (
      <Alert tone="accent" className="items-start">
        <Smartphone aria-hidden />
        <div className="grid grid-cols-1 gap-1">
          <p className="font-medium">
            On an iPhone or iPad, add this site to the Home Screen first.
          </p>
          <p className="text-muted-foreground">
            Notifications come only to the app on the Home Screen. In Safari, tap Share, then Add to
            Home Screen. Open Workspaces from the Home Screen, sign in, and turn notifications on
            here.
          </p>
        </div>
      </Alert>
    );
  }
  if (support === "blocked") {
    return (
      <Alert tone="warning" className="items-start">
        <BellOff aria-hidden />
        <p>
          Notifications are blocked for this site in this browser. Allow them in the browser's
          settings for this site, then reload this page.
        </p>
      </Alert>
    );
  }
  if (state === null) return <Loading />;
  if (state.kind === "on") {
    return (
      <div className="grid grid-cols-1 gap-3">
        <p className="flex items-start gap-2 text-sm">
          <Bell className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <span className="min-w-0">
            On. This device gets a notification when a request waits for your passkey.
          </span>
        </p>
        <Button
          variant="outline"
          className="h-auto min-h-10 w-fit max-w-full whitespace-normal py-2"
          onClick={() => disable.mutate(state.subscriptionId)}
          disabled={disable.isPending}
        >
          <BellOff aria-hidden />
          {disable.isPending ? "Turning off…" : "Turn off on this device"}
        </Button>
        <FormError error={disable.error} explain={explainNotificationError} />
      </div>
    );
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed !== "" && !DeviceLabel.safeParse(trimmed).success) {
      setLabelProblem("A name has at most 40 characters, with no control characters.");
      return;
    }
    setLabelProblem(null);
    // First, while the press still counts as one: browsers ask for permission only then.
    enable.mutate(Notification.requestPermission());
  };
  return (
    <form className="grid grid-cols-1 gap-3" onSubmit={submit}>
      {state.kind === "stopped" ? (
        <Alert tone="warning" className="items-start">
          <BellOff aria-hidden />
          <div className="grid grid-cols-1 gap-1">
            <p className="font-medium">Notifications stopped on this device.</p>
            <p className="text-muted-foreground">{STOPPED[state.reason]}</p>
          </div>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          Off. Your browser will ask whether this site may show notifications.
        </p>
      )}
      <div className="grid grid-cols-1 gap-2">
        <Label htmlFor={labelId}>Name for this device</Label>
        <Input
          id={labelId}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={40}
          aria-invalid={labelProblem !== null}
        />
        {labelProblem ? (
          <p role="alert" className="text-sm text-danger">
            {labelProblem}
          </p>
        ) : null}
      </div>
      <Button
        type="submit"
        className="h-auto min-h-12 w-full whitespace-normal py-2 sm:w-fit"
        disabled={enable.isPending}
      >
        <Bell aria-hidden />
        {enable.isPending
          ? "Waiting for your browser…"
          : state.kind === "stopped"
            ? "Turn notifications on again"
            : "Turn on notifications on this device"}
      </Button>
      <FormError error={enable.error} explain={explainNotificationError} />
    </form>
  );
}

function DeviceRow({ device, isThis }: { device: PushSubscriptionSummary; isThis: boolean }) {
  const name = device.label ?? "Unnamed device";
  const remove = useMutation({
    // This browser's own entry is turned off here as well, not only on the server.
    mutationFn: async () => {
      await removeDevice(device.id);
      if (isThis) await unsubscribeThisBrowser();
    },
    onSettled: refreshDevices,
  });
  return (
    <li className="grid grid-cols-1 gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium wrap-anywhere">{name}</p>
          <p className="text-xs text-muted-foreground">
            Added {formatTime(device.createdAt)} ·{" "}
            {device.lastSuccessAt === null
              ? "nothing sent yet"
              : `last sent ${formatTime(device.lastSuccessAt)}`}
          </p>
        </div>
        {isThis ? <Badge tone="accent">This device</Badge> : null}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${name}`}
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
        >
          <Trash2 aria-hidden />
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
      </div>
      <FormError error={remove.error} explain={explainNotificationError} />
    </li>
  );
}

/** Saves the given workspaces' switches and the quiet hours, and shows what was stored. */
function useSavePreferences() {
  return useMutation({
    mutationFn: (body: NotificationPreferences) => api.call("setNotificationPreferences", { body }),
    onSuccess: (stored) => queryClient.setQueryData(keys.notificationPreferences, stored),
  });
}

function WorkspaceSwitches({ preferences }: { preferences: NotificationPreferences }) {
  const workspaces = useWorkspaces();
  const save = useSavePreferences();
  const change = (item: WorkspaceNotifications) =>
    save.mutate({ workspaces: [item], quietHours: preferences.quietHours });
  return (
    <section aria-labelledby="per-workspace-title" className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-1 gap-1">
        <h3 id="per-workspace-title" className="text-sm font-semibold">
          Workspaces
        </h3>
        <p className="text-sm text-muted-foreground">
          You hear only about requests you can approve: in workspaces where you are an owner or an
          approver with a passkey at the signer. These switches apply to all your devices.
        </p>
      </div>
      {preferences.workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">You are not a member of any workspace yet.</p>
      ) : (
        <ul aria-labelledby="per-workspace-title" className="divide-y rounded-md border">
          {preferences.workspaces.map((item) => {
            const name =
              workspaces.data?.items.find((workspace) => workspace.id === item.workspaceId)?.name ??
              item.workspaceId;
            return (
              <li key={item.workspaceId} className="grid grid-cols-1 gap-3 px-4 py-3">
                <p className="font-medium wrap-anywhere">{name}</p>
                <SwitchRow
                  label={`Notify me about ${name}`}
                  text="Notify me"
                  checked={item.webPush}
                  disabled={save.isPending}
                  onChange={(webPush) => change({ ...item, webPush })}
                />
                <SwitchRow
                  label={`Remind me before ${name}'s requests expire`}
                  text="Remind me once, shortly before a request expires"
                  checked={item.webPush && item.reminders}
                  disabled={save.isPending || !item.webPush}
                  onChange={(reminders) => change({ ...item, reminders })}
                />
              </li>
            );
          })}
        </ul>
      )}
      <FormError error={save.error} explain={explainNotificationError} />
    </section>
  );
}

function SwitchRow({
  label,
  text,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  text: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
      <span className="text-sm" aria-hidden>
        {text}
      </span>
      <Switch
        tone="accent"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function QuietHoursEditor({ saved }: { saved: QuietHours | null }) {
  const id = useId();
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [form, setForm] = useState<QuietHoursForm>(() => quietHoursForm(saved, deviceZone));
  const [problem, setProblem] = useState<QuietHoursProblem | null>(null);
  const save = useSavePreferences();
  const zones = timeZoneChoices(Intl.supportedValuesOf("timeZone"), deviceZone, form.timeZone);
  const update = (patch: Partial<QuietHoursForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setProblem(null);
    save.reset();
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const parsed = parseQuietHours(form);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    // Only the hours: an empty list leaves every workspace's switches as they are.
    save.mutate({ workspaces: [], quietHours: parsed.value });
  };
  const fieldProblem = (field: QuietHoursProblem["field"]) =>
    problem?.field === field ? (
      <p role="alert" className="text-sm text-danger">
        {problem.message}
      </p>
    ) : null;
  return (
    <form
      aria-labelledby={`${id}-title`}
      className="grid grid-cols-1 gap-3"
      onSubmit={submit}
      noValidate
    >
      <div className="grid grid-cols-1 gap-1">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          Quiet hours
        </h3>
        <p className="text-sm text-muted-foreground">
          {saved ? describeQuietHours(saved) : "Off: notifications come at any hour of the day."} A
          request that expires before they end is not announced at all; the agent can ask again.
          Quiet hours apply to all your devices.
        </p>
      </div>
      <label className="flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-(--accent)"
          checked={form.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        Hold notifications during quiet hours
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 grid-cols-1 gap-2">
          <Label htmlFor={`${id}-start`}>From</Label>
          <Input
            id={`${id}-start`}
            type="time"
            value={form.start}
            disabled={!form.enabled}
            aria-invalid={problem?.field === "start"}
            onChange={(event) => update({ start: event.target.value })}
          />
          {fieldProblem("start")}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2">
          <Label htmlFor={`${id}-end`}>Until</Label>
          <Input
            id={`${id}-end`}
            type="time"
            value={form.end}
            disabled={!form.enabled}
            aria-invalid={problem?.field === "end"}
            onChange={(event) => update({ end: event.target.value })}
          />
          {fieldProblem("end")}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2">
          <Label htmlFor={`${id}-zone`}>Time zone</Label>
          <Select
            id={`${id}-zone`}
            value={form.timeZone}
            disabled={!form.enabled}
            aria-invalid={problem?.field === "timeZone"}
            onChange={(event) => update({ timeZone: event.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone === deviceZone ? `${zone} (this device)` : zone}
              </option>
            ))}
          </Select>
          {fieldProblem("timeZone")}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save quiet hours"}
        </Button>
        {save.isSuccess ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        ) : null}
      </div>
      <FormError error={save.error} explain={explainNotificationError} />
    </form>
  );
}

/** What each level lets a notification say, with the example a phone would show. */
function levelText(
  detail: NotificationDetail,
  workspace: WorkspaceDetail,
): { label: string; detail: string } {
  if (detail === "count") {
    return {
      label: "Only that requests wait",
      detail:
        "“Approval waiting · 1 request needs your passkey”. Someone who sees the screen learns that something waits and how much, nothing else.",
    };
  }
  const requester = workspace.agents[0]?.name ?? "Your agent";
  return {
    label: "Also the kind of request, who asked and this workspace",
    detail: `“Payment waiting · ${requester} in ${workspace.name}”. These names show on locked screens and stay in each device's notification history. They are as members typed them, so a name can read like an instruction.`,
  };
}

const LEVELS: readonly NotificationDetail[] = ["count", "summary"];

/**
 * What this workspace's notifications may say. Owners choose; everyone else sees the choice.
 * Choosing needs no passkey and is recorded in the activity log.
 */
export function NotificationLevelCard({ workspace }: { workspace: WorkspaceDetail }) {
  const id = useId();
  const isOwner = workspace.role === "owner";
  const [chosen, setChosen] = useState<NotificationDetail>(workspace.notificationDetail);
  const save = useMutation({
    mutationFn: (detail: NotificationDetail) =>
      api.call("setNotificationDetail", {
        params: { workspaceId: workspace.id },
        body: { detail },
      }),
    onSuccess: async (next) => {
      queryClient.setQueryData(keys.workspace(workspace.id), next);
      await queryClient.invalidateQueries({ queryKey: keys.audit(workspace.id) });
    },
  });
  const current = levelText(workspace.notificationDetail, workspace);
  return (
    <Card aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div className="max-w-xl">
          <CardTitle id={`${id}-title`}>What notifications say</CardTitle>
          <CardDescription>
            Notifications never show amounts or recipients. No address, memo or limit either: those
            stay on the approval page, behind a passkey sign-in.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 pt-2">
        {isOwner ? (
          <form
            className="grid grid-cols-1 gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(chosen);
            }}
          >
            <fieldset className="grid grid-cols-1 gap-3">
              <legend className="mb-3 text-sm font-medium">
                Notifications about this workspace's requests say
              </legend>
              {LEVELS.map((level) => {
                const text = levelText(level, workspace);
                return (
                  <Choice
                    key={level}
                    name={`${id}-level`}
                    label={text.label}
                    detail={text.detail}
                    checked={chosen === level}
                    onChange={() => {
                      setChosen(level);
                      save.reset();
                    }}
                  />
                );
              })}
            </fieldset>
            <p className="text-sm text-muted-foreground">
              Only owners choose this. A change is recorded in the activity log and needs no
              passkey: the signer is not involved.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="outline"
                disabled={save.isPending || chosen === workspace.notificationDetail}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              {save.isSuccess && chosen === workspace.notificationDetail ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Saved.
                </p>
              ) : null}
            </div>
            <FormError error={save.error} explain={explainNotificationError} />
          </form>
        ) : (
          <div className="grid grid-cols-1 gap-1 text-sm">
            <p>
              <span className="text-muted-foreground">They say: </span>
              <span className="font-medium">{current.label}.</span>
            </p>
            <p className="text-muted-foreground">{current.detail}</p>
            <p className="text-muted-foreground">
              Only an owner of this workspace can change this.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
