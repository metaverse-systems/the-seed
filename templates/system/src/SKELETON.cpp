#include <SKELETON.hpp>

SKELETON_::SKELETON_():
  System("SCOPE/SKELETON") 
{ 
}

SKELETON_::SKELETON_(nlohmann::json config):
  System("SCOPE/SKELETON") 
{
}

nlohmann::json SKELETON_::Export() const
{
    nlohmann::json config;
    return config;
}

void SKELETON_::Initialize()
{
}

void SKELETON_::Shutdown()
{
}

void SKELETON_::Update()
{
    double dt = this->ElapsedSecondsGet();
    // dt is the length of this update in seconds: the same however often it is read, and the configured
    // interval on the first update. It is not clamped after a stall, so cap it yourself if you need to.
    // Do some work
}

extern "C"
{
    ecs::System *create_system(void *p)
    {
        if(p == nullptr) return new SKELETON_();

        nlohmann::json *config = (nlohmann::json *)p;
        return new SKELETON_(*config);
    }
}
