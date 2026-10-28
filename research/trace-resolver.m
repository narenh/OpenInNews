// Runs macOS News's own URL resolver and logs every HTTP request it makes.
//
//   clang -fobjc-arc -framework Foundation research/trace-resolver.m -o trace-resolver
//   ./trace-resolver https://www.wired.com/story/…
//
// This is how the endpoints in the README were found. It loads the private
// NewsCore framework, so it only runs on a Mac, and only as long as Apple keeps
// these class and selector names.

#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <dlfcn.h>

static IMP originalResume;

static void loggingResume(NSURLSessionTask *task, SEL _cmd) {
    NSURLRequest *request = task.currentRequest;
    fprintf(stderr, "[HTTP] %s %s\n", request.HTTPMethod.UTF8String, request.URL.absoluteString.UTF8String);
    ((void (*)(id, SEL))originalResume)(task, _cmd);
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "usage: %s <url>\n", argv[0]);
            return 2;
        }
        dlopen("/System/Library/PrivateFrameworks/NewsCore.framework/NewsCore", RTLD_NOW);

        Method resume = class_getInstanceMethod(NSClassFromString(@"__NSCFLocalSessionTask"), @selector(resume));
        originalResume = method_setImplementation(resume, (IMP)loggingResume);

        NSURL *caches = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:@"trace-resolver"]];
        [NSFileManager.defaultManager createDirectoryAtURL:caches withIntermediateDirectories:YES attributes:nil error:nil];

        id context = ((id (*)(id, SEL))objc_msgSend)(NSClassFromString(@"FCContextConfiguration"), NSSelectorFromString(@"defaultConfiguration"));
        id configuration = ((id (*)(id, SEL, id, id, id))objc_msgSend)([NSClassFromString(@"FCConfigurationManager") alloc],
            NSSelectorFromString(@"initWithContextConfiguration:contentHostDirectoryFileURL:feldsparIDProvider:"), context, caches, nil);
        id reachability = ((id (*)(id, SEL))objc_msgSend)(NSClassFromString(@"FCNetworkReachability"), NSSelectorFromString(@"sharedNetworkReachability"));
        id resolver = ((id (*)(id, SEL, id, id, id))objc_msgSend)([NSClassFromString(@"FCWebURLResolutionEndpointConnection") alloc],
            NSSelectorFromString(@"initWithConfigurationManager:cachesDirectoryURL:networkReachability:"), configuration, caches, reachability);

        __block BOOL done = NO;
        void (^completion)(id, id) = ^(id articleID, id error) {
            printf("article ID: %s\nerror: %s\n", [[articleID description] UTF8String], [[error description] UTF8String]);
            done = YES;
        };
        ((void (*)(id, SEL, id, long, id))objc_msgSend)(resolver, NSSelectorFromString(@"resolveWebURL:withQualityOfService:completion:"),
            [NSURL URLWithString:@(argv[1])], NSQualityOfServiceUserInitiated, completion);

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
        while (!done && deadline.timeIntervalSinceNow > 0) {
            [NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
        }
    }
    return 0;
}
