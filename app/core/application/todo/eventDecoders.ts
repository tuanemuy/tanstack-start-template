import { z } from "zod";
import type { EventDecoder } from "@/core/domain/common/event";
import type { TodoEvent } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import { buildEventDecoder } from "../events/buildDecoder";

const todoCreatedSchema = z
  .object({ todoId: z.string(), title: z.string() })
  .strict();
const todoToggledSchema = z
  .object({ todoId: z.string(), completed: z.boolean() })
  .strict();
const todoRenamedSchema = z
  .object({ todoId: z.string(), title: z.string() })
  .strict();
const todoDeletedSchema = z.object({ todoId: z.string() }).strict();

export type TodoEventDecoders = {
  readonly [K in TodoEvent["type"]]: EventDecoder<
    Extract<TodoEvent, { type: K }>
  >;
};

export const todoEventDecoders: TodoEventDecoders = {
  "todo.created": buildEventDecoder("todo.created", todoCreatedSchema, (p) => ({
    todoId: TodoId.create(p.todoId),
    title: TodoTitle.create(p.title),
  })),
  "todo.toggled": buildEventDecoder("todo.toggled", todoToggledSchema, (p) => ({
    todoId: TodoId.create(p.todoId),
    completed: p.completed,
  })),
  "todo.renamed": buildEventDecoder("todo.renamed", todoRenamedSchema, (p) => ({
    todoId: TodoId.create(p.todoId),
    title: TodoTitle.create(p.title),
  })),
  "todo.deleted": buildEventDecoder("todo.deleted", todoDeletedSchema, (p) => ({
    todoId: TodoId.create(p.todoId),
  })),
};
