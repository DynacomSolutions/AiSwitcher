/* Read-only GPT recovery gate. No block device is ever opened for writing.
 * Accept the image's narrow GPT format, independently check both CRC pairs,
 * and export an sgdisk backup only when precisely one whole copy survives.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

enum { SECTOR = 512, TABLE = 128 * 128, HEADER = 92 };
struct copy { unsigned char h[SECTOR], t[TABLE]; uint64_t at; int valid; };
struct part { uint64_t start, size, attrs; char type[37], uuid[37], name[37]; };
static struct part expected[4];
static char template_guid[37];
static uint64_t sectors;

static void fail(const char *why) { fprintf(stderr, "ais-gpt-check: %s\n", why); exit(1); }
static uint32_t u32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static uint64_t u64(const unsigned char *p) { return u32(p) | (uint64_t)u32(p+4)<<32; }
static void put32(unsigned char *p, uint32_t v) { for (int i=0;i<4;i++) p[i]=(unsigned char)(v>>(i*8)); }
static void put64(unsigned char *p, uint64_t v) { for (int i=0;i<8;i++) p[i]=(unsigned char)(v>>(i*8)); }
static uint32_t crc(const unsigned char *p, size_t size) {
    uint32_t v=~0U;
    for (size_t i=0;i<size;i++) {
        v^=p[i];
        for (int j=0;j<8;j++) v=(v>>1) ^ (0xedb88320U & (0U-(v&1)));
    }
    return ~v;
}
static int zero(const unsigned char *p, size_t n) {
    for (size_t i=0;i<n;i++) if (p[i]) return 0;
    return 1;
}
static int uuid_valid(const char *s) {
    if (strlen(s)!=36) return 0;
    for (int i=0;i<36;i++) {
        if (i==8 || i==13 || i==18 || i==23) { if (s[i]!='-') return 0; }
        else if (!((s[i]>='0' && s[i]<='9') || (s[i]>='a' && s[i]<='f'))) return 0;
    }
    return s[14]>='1' && s[14]<='5' && strchr("89ab",s[19]);
}
static void guid(const unsigned char *p, char s[37]) {
    snprintf(s,37,"%08" PRIx32 "-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        u32(p),p[4]|p[5]<<8,p[6]|p[7]<<8,p[8],p[9],p[10],p[11],p[12],p[13],p[14],p[15]);
}
static int read_at(int fd, void *p, size_t n, uint64_t lba) {
    if (lba>=sectors || n>(sectors-lba)*SECTOR) return 0;
    return pread(fd,p,n,(off_t)(lba*SECTOR))==(ssize_t)n;
}
static void read_copy(int fd, struct copy *c, uint64_t at) {
    c->at=at; c->valid=0;
    if (!read_at(fd,c->h,SECTOR,at)) return;
    uint32_t size=u32(c->h+12);
    if (memcmp(c->h,"EFI PART",8) || size<HEADER || size>SECTOR) return;
    unsigned char h[SECTOR]; memcpy(h,c->h,SECTOR); put32(h+16,0);
    if (crc(h,size)!=u32(c->h+16)) return;
    /* Nonstandard but CRC-valid metadata is not repairable under this policy. */
    uint64_t alternate=u64(c->h+32), table=u64(c->h+72);
    if (u32(c->h+8)!=0x10000 || size!=HEADER ||
        u64(c->h+24)!=at || alternate>=sectors || alternate==at ||
        u32(c->h+20) || !zero(c->h+HEADER,SECTOR-HEADER) ||
        u32(c->h+80)!=128 || u32(c->h+84)!=128 ||
        (at==1 ? (table!=2 || alternate<34) : (alternate!=1 || at<34 || table!=at-32)))
        fail("unsupported CRC-valid header");
    if (!read_at(fd,c->t,TABLE,table)) return;
    if (crc(c->t,TABLE)!=u32(c->h+88)) return;
    c->valid=1;
}
static void manifest(const char *path) {
    static const char *types[]={"21686148-6449-6e6f-744e-656564454649","c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
        "0fc63daf-8483-4772-8e79-3d69d8477de4","ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"};
    static const char *names[]={"BIOS","AISBOOT","AISBASE","AISX"};
    FILE *f=fopen(path,"r"); if (!f) fail("missing layout manifest");
    char line[512], canonical[512], attrs[32]; int consumed=0, number=0;
    if (!fgets(line,sizeof line,f) || strcmp(line,"AIS-GPT-LAYOUT\t1\n")) fail("invalid manifest version");
    if (!fgets(line,sizeof line,f) || sscanf(line,"disk-guid\t%36s%n",template_guid,&consumed)!=1 ||
        strcmp(line+consumed,"\n") || !uuid_valid(template_guid)) fail("invalid template GUID");
    snprintf(canonical,sizeof canonical,"disk-guid\t%s\n",template_guid);
    if (strcmp(line,canonical)) fail("noncanonical template GUID row");
    for (int i=0;i<4;i++) {
        struct part *p=&expected[i];
        if (!fgets(line,sizeof line,f) || sscanf(line,"part\t%d\t%" SCNu64 "\t%" SCNu64 "\t%36s\t%36s\t%36s\t%31s%n",
            &number,&p->start,&p->size,p->type,p->uuid,p->name,attrs,&consumed)!=7 || strcmp(line+consumed,"\n") ||
            number!=i+1 || strcmp(p->type,types[i]) || strcmp(p->name,names[i]) ||
            strcmp(attrs,i==1?"LegacyBIOSBootable":"-") || !uuid_valid(p->uuid) ||
            !strcmp(p->uuid,template_guid) || !p->size || p->start>=sectors || p->size>sectors-p->start ||
            (i==0 ? p->start!=2048 : p->start!=expected[i-1].start+expected[i-1].size)) fail("invalid image layout");
        /* scanf accepts whitespace, signs and leading zeroes. Require the
         * producer's exact representation before any repair can be allowed. */
        snprintf(canonical,sizeof canonical,"part\t%d\t%" PRIu64 "\t%" PRIu64 "\t%s\t%s\t%s\t%s\n",
            number,p->start,p->size,p->type,p->uuid,p->name,attrs);
        if (strcmp(line,canonical)) fail("noncanonical image layout row");
        for (int j=0;j<i;j++) if (!strcmp(p->uuid,expected[j].uuid)) fail("duplicate template UUID");
        p->attrs=i==1?4:0;
    }
    if (fgetc(f)!=EOF || ferror(f)) fail("extra manifest input");
    fclose(f);
}
static void layout(const struct copy *c, const char *boot_uuid) {
    uint64_t last=u64(c->h+48), end=c->at==1?u64(c->h+32):c->at;
    if (u64(c->h+40)!=2048 || last!=end-33 || last<expected[3].start+expected[3].size-1)
        fail("invalid usable extent");
    char seen[6][37]; guid(c->h+56,seen[0]);
    if (!uuid_valid(seen[0])) fail("invalid disk GUID");
    int template=!strcmp(seen[0],template_guid);
    for (int i=0;i<128;i++) {
        const unsigned char *e=c->t+i*128;
        if (i>=5 || (i==4 && zero(e,128))) { if (!zero(e,128)) fail("unexpected partition"); continue; }
        char type[37]; guid(e,type); guid(e+16,seen[i+1]);
        if (!uuid_valid(seen[i+1])) fail("invalid partition UUID");
        for (int j=0;j<=i;j++) if (!strcmp(seen[i+1],seen[j])) fail("duplicate UUID");
        uint64_t start=u64(e+32), finish=u64(e+40), attrs=u64(e+48);
        if (finish<start || finish>last) fail("partition beyond usable extent");
        if (i<4) {
            const struct part *p=&expected[i];
            unsigned char expected_name[72]={0};
            for (size_t j=0;j<strlen(p->name);j++) expected_name[j*2]=(unsigned char)p->name[j];
            if (start!=p->start || finish-start+1!=p->size || strcmp(type,p->type) ||
                attrs!=p->attrs || memcmp(e+56,expected_name,72)) fail("partition differs from image");
            if ((!strcmp(seen[i+1],p->uuid))!=template) fail("partly randomised copy");
            if (i==1 && *boot_uuid && strcmp(boot_uuid,seen[i+1])) fail("firmware partition belongs to another disk");
        } else {
            uint64_t p5=(expected[3].start+expected[3].size+2047)/2048*2048;
            unsigned char expected_name[72]={0};
            const char *persist="AISPERSIST";
            for (size_t j=0;j<strlen(persist);j++) expected_name[j*2]=(unsigned char)persist[j];
            if (template || start!=p5 || finish!=sectors-34 || last!=sectors-34 || attrs ||
                strcmp(type,expected[2].type) || memcmp(e+56,expected_name,72)) fail("invalid persistence extent");
        }
    }
}
static void header_crc(unsigned char *h) { put32(h+16,0); put32(h+16,crc(h,HEADER)); }
static void backup(const char *path, const unsigned char *mbr, const struct copy *c) {
    unsigned char main[SECTOR], secondary[SECTOR], protective[SECTOR];
    memcpy(main,c->h,SECTOR); memcpy(secondary,c->h,SECTOR);
    uint64_t last=sectors-1;
    memcpy(protective,mbr,SECTOR);
    put32(protective+458,last>UINT32_MAX?UINT32_MAX:(uint32_t)last);
    put64(main+48,last-33); put64(secondary+48,last-33);
    put64(main+24,1); put64(main+32,last); put64(main+72,2); header_crc(main);
    put64(secondary+24,last); put64(secondary+32,1); put64(secondary+72,last-32); header_crc(secondary);
    int fd=open(path,O_WRONLY|O_CREAT|O_NOFOLLOW,0600);
    if (fd<0) fail("cannot create recovery backup");
    struct stat st;
    if (fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_nlink!=1) fail("unsafe backup destination");
    if (ftruncate(fd,0)) fail("cannot truncate recovery backup");
    /* sgdisk backup format: protective MBR, primary header, secondary header,
     * then the one authoritative table. Place metadata at the physical end
     * ourselves: sgdisk's automatic growth can reserve an extra alignment gap. */
    if (write(fd,protective,SECTOR)!=SECTOR || write(fd,main,SECTOR)!=SECTOR ||
        write(fd,secondary,SECTOR)!=SECTOR || write(fd,c->t,TABLE)!=TABLE || close(fd)) fail("cannot write recovery backup");
}
int main(int argc, char **argv) {
    if (argc!=5) fail("usage: ais-gpt-check disk manifest backup boot-partuuid");
    if (*argv[4] && !uuid_valid(argv[4])) fail("invalid firmware PARTUUID");
    int fd=open(argv[1],O_RDONLY); if (fd<0) fail("cannot open disk read-only");
    struct stat st; uint64_t bytes; unsigned int logical=SECTOR;
    if (fstat(fd,&st)) fail("cannot stat disk");
    if (S_ISREG(st.st_mode)) bytes=(uint64_t)st.st_size;
    else if (S_ISBLK(st.st_mode)) {
        if (ioctl(fd,BLKGETSIZE64,&bytes) || ioctl(fd,BLKSSZGET,&logical)) fail("cannot size disk");
    } else fail("not a disk or regular image");
    if (logical!=SECTOR || bytes%SECTOR || bytes<4096*SECTOR || bytes>INT64_MAX) fail("unsupported disk size");
    sectors=bytes/SECTOR;
    manifest(argv[2]);
    unsigned char mbr[SECTOR];
    if (!read_at(fd,mbr,SECTOR,0) || mbr[510]!=0x55 || mbr[511]!=0xaa || mbr[450]!=0xee ||
        u32(mbr+454)!=1 || !zero(mbr+462,48)) fail("invalid protective MBR");
    struct copy primary={0}, secondary={0};
    read_copy(fd,&primary,1);
    /* A valid header supplies the original backup location on a grown image.
     * With a damaged header try the physical end, then the assembler's fixed
     * 2048-sector reserve. Never search arbitrary data for GPT signatures. */
    unsigned char h[HEADER]; memcpy(h,primary.h,HEADER); put32(h+16,0);
    int header_valid=!memcmp(h,"EFI PART",8) && u32(h+12)==HEADER && crc(h,HEADER)==u32(primary.h+16);
    uint64_t at=header_valid?u64(primary.h+32):sectors-1;
    read_copy(fd,&secondary,at);
    uint64_t original=expected[3].start+expected[3].size+2048-1;
    if (!header_valid && !secondary.valid && original!=at && original<sectors) read_copy(fd,&secondary,original);
    if (!primary.valid && !secondary.valid) fail("no complete CRC-valid GPT copy");
    if (primary.valid) layout(&primary,argv[4]);
    if (secondary.valid) layout(&secondary,argv[4]);
    if (primary.valid && secondary.valid) {
        if (u64(primary.h+32)!=secondary.at || memcmp(primary.h+40,secondary.h+40,32) ||
            memcmp(primary.t,secondary.t,TABLE)) fail("CRC-valid GPT copies disagree");
        puts("clean");
    } else {
        backup(argv[3],mbr,primary.valid?&primary:&secondary);
        puts("repair");
    }
    close(fd);
    return 0;
}
