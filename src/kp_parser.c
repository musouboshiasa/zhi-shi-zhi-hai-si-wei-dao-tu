/**
 * The Sea of Knowledge — 知识点文件解析器（C语言核心）
 *
 * 编译: gcc -o kp_parser kp_parser.c
 * 用法: ./kp_parser <文件路径> [选项]
 *   选项:
 *     --number    只输出编号
 *     --content   只输出正文
 *     --prev      只输出前相关
 *     --next      只输出后相关
 *     --json      以JSON格式输出（可供Node.js调用）
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <locale.h>

#ifdef _WIN32
#include <windows.h>
#define UTF8_INPUT 1
#endif

#define MAX_LINE 65536
#define MAX_SECTION 1048576
#define MAX_RELATED 1024

typedef enum {
    SECTION_NONE,
    SECTION_NUMBER,
    SECTION_CONTENT,
    SECTION_PREV,
    SECTION_NEXT
} Section;

typedef struct {
    char number[256];
    char content[MAX_SECTION];
    char prev_lines[MAX_RELATED][512];
    int prev_count;
    char next_lines[MAX_RELATED][512];
    int next_count;
} KnowledgePoint;

// 移除行尾的换行符
void trim_newline(char *line) {
    size_t len = strlen(line);
    while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) {
        line[--len] = '\0';
    }
}

// 解析知识点文件
int parse_file(const char *filepath, KnowledgePoint *kp) {
    FILE *fp = fopen(filepath, "rb");
    if (!fp) {
        fprintf(stderr, "错误: 无法打开文件 '%s'\n", filepath);
        return -1;
    }

    memset(kp, 0, sizeof(KnowledgePoint));
    kp->content[0] = '\0';

    Section section = SECTION_NONE;
    char line[MAX_LINE];
    size_t content_offset = 0;
    int stopped = 0;

    while (fgets(line, sizeof(line), fp) && !stopped) {
        trim_newline(line);

        // 检测结束符
        if (strcmp(line, "（（结束））") == 0 || strcmp(line, "((结束))") == 0) {
            stopped = 1;
            break;
        }

        // 检测区域切换
        if (strcmp(line, "（（编号区））") == 0 || strcmp(line, "((编号区))") == 0) { section = SECTION_NUMBER; continue; }
        if (strcmp(line, "（（正文区））") == 0 || strcmp(line, "((正文区))") == 0) { section = SECTION_CONTENT; continue; }
        if (strcmp(line, "（（前相关区））") == 0 || strcmp(line, "((前相关区))") == 0) { section = SECTION_PREV; continue; }
        if (strcmp(line, "（（后相关区））") == 0 || strcmp(line, "((后相关区))") == 0) { section = SECTION_NEXT; continue; }

        switch (section) {
            case SECTION_NUMBER:
                strncpy(kp->number, line, sizeof(kp->number) - 1);
                break;
            case SECTION_CONTENT:
                if (content_offset + strlen(line) + 2 < MAX_SECTION) {
                    if (content_offset > 0) {
                        kp->content[content_offset++] = '\n';
                    }
                    strcpy(kp->content + content_offset, line);
                    content_offset += strlen(line);
                }
                break;
            case SECTION_PREV:
                if (kp->prev_count < MAX_RELATED && strlen(line) > 0) {
                    strncpy(kp->prev_lines[kp->prev_count], line, sizeof(kp->prev_lines[0]) - 1);
                    kp->prev_count++;
                }
                break;
            case SECTION_NEXT:
                if (kp->next_count < MAX_RELATED && strlen(line) > 0) {
                    strncpy(kp->next_lines[kp->next_count], line, sizeof(kp->next_lines[0]) - 1);
                    kp->next_count++;
                }
                break;
            default:
                break;
        }
    }

    fclose(fp);
    return 0;
}

// JSON转义
void json_escape(const char *src, char *dst, size_t max_len) {
    size_t j = 0;
    for (size_t i = 0; src[i] && j < max_len - 2; i++) {
        switch (src[i]) {
            case '"':  if (j < max_len-3) { dst[j++]='\\'; dst[j++]='"'; } break;
            case '\\': if (j < max_len-3) { dst[j++]='\\'; dst[j++]='\\'; } break;
            case '\n': if (j < max_len-3) { dst[j++]='\\'; dst[j++]='n'; } break;
            case '\r': if (j < max_len-3) { dst[j++]='\\'; dst[j++]='r'; } break;
            case '\t': if (j < max_len-3) { dst[j++]='\\'; dst[j++]='t'; } break;
            default: dst[j++] = src[i];
        }
    }
    dst[j] = '\0';
}

// 输出JSON
void output_json(KnowledgePoint *kp) {
    char escaped_content[MAX_SECTION * 2];
    json_escape(kp->content, escaped_content, sizeof(escaped_content));

    printf("{\n");
    printf("  \"number\": \"%s\",\n", kp->number);
    printf("  \"content\": \"%s\",\n", escaped_content);
    printf("  \"prevRelated\": [\n");
    for (int i = 0; i < kp->prev_count; i++) {
        printf("    \"%s\"%s\n", kp->prev_lines[i], i < kp->prev_count - 1 ? "," : "");
    }
    printf("  ],\n");
    printf("  \"nextRelated\": [\n");
    for (int i = 0; i < kp->next_count; i++) {
        printf("    \"%s\"%s\n", kp->next_lines[i], i < kp->next_count - 1 ? "," : "");
    }
    printf("  ]\n");
    printf("}\n");
}

int main(int argc, char *argv[]) {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
#endif
    setlocale(LC_ALL, "");

    if (argc < 2) {
        printf("用法: %s <知识点文件路径> [--number|--content|--prev|--next|--json|--validate]\n", argv[0]);
        printf("示例:\n");
        printf("  %s \"1-2-2：手部.md\" --json\n", argv[0]);
        printf("  %s \"1-2-2：手部.md\" --content\n", argv[0]);
        return 1;
    }

    const char *filepath = argv[1];
    const char *option = argc > 2 ? argv[2] : "--json";

    KnowledgePoint kp;
    if (parse_file(filepath, &kp) != 0) {
        return 1;
    }

    if (strcmp(option, "--json") == 0) {
        output_json(&kp);
    } else if (strcmp(option, "--number") == 0) {
        printf("%s\n", kp.number);
    } else if (strcmp(option, "--content") == 0) {
        printf("%s\n", kp.content);
    } else if (strcmp(option, "--prev") == 0) {
        for (int i = 0; i < kp.prev_count; i++) {
            printf("%s\n", kp.prev_lines[i]);
        }
    } else if (strcmp(option, "--next") == 0) {
        for (int i = 0; i < kp.next_count; i++) {
            printf("%s\n", kp.next_lines[i]);
        }
    } else if (strcmp(option, "--validate") == 0) {
        // 验证文件格式
        int valid = 1;
        if (strlen(kp.number) == 0) {
            printf("警告: 编号为空\n");
            valid = 0;
        }
        printf("编号: %s\n", kp.number);
        printf("正文长度: %zu 字符\n", strlen(kp.content));
        printf("前相关知识: %d 个\n", kp.prev_count);
        printf("后相关知识: %d 个\n", kp.next_count);
        printf("验证结果: %s\n", valid ? "✓ 格式正确" : "✗ 格式有误");
    } else {
        fprintf(stderr, "未知选项: %s\n", option);
        return 1;
    }

    return 0;
}
