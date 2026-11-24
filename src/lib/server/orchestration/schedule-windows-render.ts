import { DOMParser, onErrorStopParsing, type Element } from "@xmldom/xmldom";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { DateTime, Either } from "effect";
import { OSLO_ZONE } from "../clock.ts";
import { validatePeriod } from "../profile/schedule-period.ts";
import type { ScheduleRenderInput } from "./schedule-render.ts";

// A drive-relative path (C:foo) or a path rooted on the current drive is not enough.
const drivePath = (value: string) => /^[a-z]:\\/i.test(value);

const safeActionValue = (value: string): string => {
  if (/[%"\ufffe\uffff]/u.test(value) || !value.isWellFormed() || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error("Unsupported task action characters");
  }

  return value;
};

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const quoteArg = (value: string) => `"${safeActionValue(value).replace(/\\+$/u, (slashes) => slashes + slashes)}"`;
const namespace = "http://schemas.microsoft.com/windows/2004/02/mit/task";

const taskAction = (root: string, command: readonly string[]) => {
  const [executable, ...args] = command;

  if (!executable || !drivePath(executable) || !drivePath(root)) throw new Error("Task needs absolute local drive paths");

  return { Command: safeActionValue(executable), Arguments: args.map(quoteArg).join(" "), WorkingDirectory: safeActionValue(root) };
};

const children = (parent: Element) => Array.from(parent.childNodes).filter((child): child is Element => child.nodeType === 1);

const onlyChild = (parent: Element, name: string) => {
  const matching = children(parent).filter((child) => child.namespaceURI === namespace && child.localName === name);

  return matching.length === 1 ? matching[0] : undefined;
};

export const matchesWindowsTask = (definition: string, root: string, command: readonly string[], user: string): boolean => {
  try {
    const parsed = new DOMParser({ onError: onErrorStopParsing }).parseFromString(definition, "application/xml");
    const task = parsed.documentElement;

    if (parsed.doctype || task?.namespaceURI !== namespace || task.localName !== "Task") return false;
    const principals = onlyChild(task, "Principals");
    const actions = onlyChild(task, "Actions");

    if (!principals || !actions || children(principals).length !== 1 || children(actions).length !== 1) return false;
    const principal = onlyChild(principals, "Principal");
    const exec = onlyChild(actions, "Exec");

    if (!principal || !exec || actions.getAttribute("Context") !== principal.getAttribute("id")) return false;

    return onlyChild(principal, "UserId")?.textContent === user &&
      onlyChild(principal, "LogonType")?.textContent === "InteractiveToken" &&
      onlyChild(principal, "RunLevel")?.textContent === "LeastPrivilege" &&
      Object.entries(taskAction(root, command)).every(([name, value]) => onlyChild(exec, name)?.textContent === value);
  } catch {
    return false;
  }
};

export const windowsTaskName = (root: string, profileId: string, user: string): string => {
  if (!drivePath(root) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profileId)) throw new Error("Invalid task target");
  const digest = createHash("sha256").update(JSON.stringify([win32.normalize(root).toLowerCase(), user.toLowerCase()])).digest("hex").slice(0, 16);

  return `\\job-market-pulse-${profileId.toLowerCase()}-${digest}`;
};

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const namedTags = (names: readonly string[]) => names.map((name) => `<${name}/>`).join("");

const osloDay = (after: string): string => DateTime.unsafeMake(after).pipe(DateTime.setZone(OSLO_ZONE), DateTime.formatIsoDate);

export const renderWindowsTask = (input: ScheduleRenderInput, user: string, after: string): string => {
  windowsTaskName(input.resolvedRoot, input.profileId, user);
  const action = taskAction(input.resolvedRoot, input.command);

  if (!user) throw new Error("Task needs a user");

  const period = Either.getOrThrow(validatePeriod(input.period));
  const boundary = `${period.anchor ?? osloDay(after)}T${period.time}:00`;

  const calendar = period.kind === "monthly"
    ? `<ScheduleByMonth><DaysOfMonth><Day>${period.day_of_month}</Day></DaysOfMonth><Months>${namedTags(months)}</Months></ScheduleByMonth>`
    : period.kind === "weekly" || period.kind === "every_n_weeks"
      ? `<ScheduleByWeek><WeeksInterval>${period.n}</WeeksInterval><DaysOfWeek><${weekdays[period.weekday ?? 0] ?? "Monday"}/></DaysOfWeek></ScheduleByWeek>`
      : `<ScheduleByDay><DaysInterval>${period.n}</DaysInterval></ScheduleByDay>`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="${namespace}">
  <Triggers><CalendarTrigger><StartBoundary>${boundary}</StartBoundary>${calendar}</CalendarTrigger></Triggers>
  <Principals><Principal id="PulseUser"><UserId>${xml(safeActionValue(user))}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StartWhenAvailable>false</StartWhenAvailable>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="PulseUser"><Exec>
    <Command>${xml(action.Command)}</Command>
    <Arguments>${xml(action.Arguments)}</Arguments>
    <WorkingDirectory>${xml(action.WorkingDirectory)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
};
