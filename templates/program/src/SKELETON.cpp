#include "SKELETON.hpp"
#include <iostream>

void run(int argc, char *argv[])
{
    auto world = ECS->Container();

    world->Start(1000000 / 30);

    while(ECS->IsRunning())
    {
        usleep(100000);
    }
}

int main(int argc, char *argv[])
{
    try
    {
        run(argc, argv);
    }
    catch(std::runtime_error e)
    {
        std::cout << e.what() << std::endl;
        return 1;
    }
    return 0;
}
